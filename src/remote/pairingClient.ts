import {inferTlsMode, orderedPairedEndpoints, type PairingPayload, type PairedDesktop} from '../domain/pairing';
import {PinnedGateway, TransportTlsOptions} from '../native/PinnedGateway';
import {
  DeviceIdentitySecret,
  loadOrCreateDeviceIdentity,
  saveDesktopCredential,
} from '../services/secureStore';
import {
  completeDevicePairing,
  createPairingConfirmRequest,
  PairingStartResponse,
  RemoteDeviceIdentity,
  startDevicePairing,
} from './pairing';
import {
  REMOTE_PAIR_CONFIRM_PATH,
  REMOTE_PAIR_START_PATH,
  REMOTE_PROTOCOL_VERSION,
  remoteError,
} from './protocol';

export type PairDeviceInfo = {
  displayName: string;
  platform: string;
  deviceModel: string;
  appVersion: string;
};

type PairingConfirmResponse = {
  v: 2;
  desktopId: string;
  desktopName: string;
  certificateFingerprint: string;
  desktopIdentityPublicKey: string;
  device?: {deviceId?: string};
};

// Native HTTPS errors share one bridge code. Only explicitly unreachable network
// errors may try another QR-provided address; TLS/identity/HTTP failures fail closed.
function canTryPairingEndpoint(error: unknown): boolean {
  const failure = error as {code?: string; message?: string};
  if (failure?.code !== 'HTTPS_REQUEST_FAILED') return false;
  const message = String(failure.message || '');
  if (/certificate|ssl|tls|pinning|fingerprint|hostname|证书|指纹|主机名/i.test(message)) return false;
  return /failed to connect|connect.*tim(?:ed?\s*out|eout)|connection refused|no route to host|network is unreachable|unable to resolve host|could not connect|cannot connect|network connection was lost|internet connection appears to be offline|无法连接|未能连接|找不到.*服务器/i.test(message);
}


function tlsOptions(payload: PairingPayload): TransportTlsOptions {
  return payload.tlsMode === 'pinned'
    ? {
        tlsMode: 'pinned',
        certificateFingerprint: payload.certificateFingerprint,
      }
    : {tlsMode: 'system'};
}

function parseHttpObject(
  status: number,
  body: string,
  stage: 'start' | 'confirm',
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw remoteError(`remote_pairing_${stage}_response_invalid`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw remoteError(`remote_pairing_${stage}_response_invalid`);
  }
  const record = value as Record<string, unknown>;
  if (status < 200 || status >= 300 || record.ok !== true) {
    const code = typeof record.error === 'string' && record.error.startsWith('remote_')
      ? record.error
      : `remote_pairing_${stage}_failed`;
    throw remoteError(code);
  }
  return record;
}

function assertDesktopBinding(
  response: Record<string, unknown>,
  payload: PairingPayload,
): void {
  if (
    response.desktopId !== payload.desktopId ||
    response.desktopIdentityPublicKey !== payload.desktopIdentityPublicKey ||
    response.certificateFingerprint !== payload.certificateFingerprint
  ) {
    throw remoteError('remote_pairing_desktop_identity_mismatch');
  }
}

function normalizeStartResponse(
  response: Record<string, unknown>,
  payload: PairingPayload,
): PairingStartResponse {
  assertDesktopBinding(response, payload);
  const result = response as Partial<PairingStartResponse>;
  if (
    Number(result.v) !== REMOTE_PROTOCOL_VERSION ||
    typeof result.pairingAttemptId !== 'string' ||
    typeof result.desktopName !== 'string' ||
    typeof result.serverEphemeralPublicKey !== 'string' ||
    typeof result.desktopProof !== 'string' ||
    typeof result.transcriptHash !== 'string' ||
    (typeof result.expiresAt !== 'string' && typeof result.expiresAt !== 'number')
  ) {
    throw remoteError('remote_pairing_start_response_invalid');
  }
  return result as PairingStartResponse;
}

function normalizeConfirmResponse(
  response: Record<string, unknown>,
  payload: PairingPayload,
  identity: DeviceIdentitySecret,
): PairingConfirmResponse {
  assertDesktopBinding(response, payload);
  const result = response as Partial<PairingConfirmResponse>;
  if (
    Number(result.v) !== REMOTE_PROTOCOL_VERSION ||
    typeof result.desktopName !== 'string' ||
    result.device?.deviceId !== identity.deviceId
  ) {
    throw remoteError('remote_pairing_confirm_response_invalid');
  }
  return result as PairingConfirmResponse;
}

export async function pairDesktop({
  payload,
  pairingCode,
  deviceInfo,
}: {
  payload: PairingPayload;
  pairingCode: string;
  deviceInfo: PairDeviceInfo;
}): Promise<PairedDesktop> {
  const identity = await loadOrCreateDeviceIdentity();
  const context = {
    pairingId: payload.pairingId,
    pairingChallenge: payload.pairingChallenge,
    desktopId: payload.desktopId,
  };
  const device: RemoteDeviceIdentity = {
    deviceId: identity.deviceId,
    displayName: deviceInfo.displayName.trim().slice(0, 80) || 'Anywhere Mobile',
    platform: deviceInfo.platform.trim().slice(0, 40) || 'unknown',
    deviceModel: deviceInfo.deviceModel?.trim().replace(/\s+/g, ' ').slice(0, 80) || '',
    appVersion: deviceInfo.appVersion.trim().slice(0, 80),
    publicKey: identity.publicKey,
  };
  const started = startDevicePairing({
    desktopPublicKey: payload.desktopIdentityPublicKey,
    context,
    pairingCode,
    device,
  });
  const candidates = orderedPairedEndpoints(payload);
  let selectedPayload = payload;
  let startResponse: PairingStartResponse | undefined;
  for (let index = 0; index < candidates.length; index++) {
    const endpoint = candidates[index];
    selectedPayload = {...payload, endpoint, tlsMode: inferTlsMode(endpoint)};
    let startHttp;
    try {
      startHttp = await PinnedGateway.postJson({
        endpoint,
        path: REMOTE_PAIR_START_PATH,
        body: JSON.stringify(started.envelope),
        ...tlsOptions(selectedPayload),
      });
    } catch (error) {
      if (index + 1 < candidates.length && canTryPairingEndpoint(error)) continue;
      throw error;
    }
    // An HTTP response or failed identity/proof is never permission to switch peers.
    startResponse = normalizeStartResponse(
      parseHttpObject(startHttp.status, startHttp.body, 'start'),
      selectedPayload,
    );
    break;
  }
  if (!startResponse) throw remoteError('remote_pairing_start_failed');
  const transport = tlsOptions(selectedPayload);
  const completed = completeDevicePairing({
    devicePrivateKey: identity.privateKey,
    desktopPublicKey: payload.desktopIdentityPublicKey,
    serverEphemeralPublicKey: startResponse.serverEphemeralPublicKey,
    clientEphemeralPrivateKey: started.clientEphemeralKeyPair.privateKey,
    devicePublicKey: identity.publicKey,
    context,
    desktopProof: startResponse.desktopProof,
    expectedTranscriptHash: startResponse.transcriptHash,
  });
  const confirmation = createPairingConfirmRequest({
    context,
    pairingAttemptId: startResponse.pairingAttemptId,
    deviceId: identity.deviceId,
    deviceProof: completed.deviceProof,
  });
  const confirmHttp = await PinnedGateway.postJson({
    endpoint: selectedPayload.endpoint,
    path: REMOTE_PAIR_CONFIRM_PATH,
    body: JSON.stringify(confirmation),
    ...transport,
  });
  const confirmResponse = normalizeConfirmResponse(
    parseHttpObject(confirmHttp.status, confirmHttp.body, 'confirm'),
    payload,
    identity,
  );

  // Persist only after Desktop accepts the device proof. A failed or interrupted
  // pair attempt leaves no root secret associated with this Desktop.
  await saveDesktopCredential({
    version: 2,
    desktopId: payload.desktopId,
    rootSecret: completed.rootSecret,
    savedAt: new Date().toISOString(),
  });
  return {
    id: payload.desktopId,
    name: confirmResponse.desktopName.trim() || payload.desktopName,
    endpoint: selectedPayload.endpoint,
    endpoints: payload.endpoints,
    certificateFingerprint: payload.certificateFingerprint,
    desktopIdentityPublicKey: payload.desktopIdentityPublicKey,
    tlsMode: selectedPayload.tlsMode,
    pairedAt: new Date().toISOString(),
  };
}
