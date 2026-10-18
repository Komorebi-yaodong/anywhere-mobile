import {useCallback, useEffect, useRef, useState} from 'react';
import type {RemoteRequest} from '../remote/api';
import type {RemoteUpload} from '../remote/attachments';

export function useAttachmentQueue(desktopId: string, request: RemoteRequest) {
  const [uploads, setUploads] = useState<RemoteUpload[]>([]);
  const records = useRef<RemoteUpload[]>([]);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      for (const upload of records.current) {
        request(desktopId, 'attachment.abort', {uploadId: upload.uploadId}).catch(() => undefined);
      }
      records.current = [];
    };
  }, [desktopId, request]);

  const add = useCallback(async () => {
    if (controller.current || records.current.length >= 8) return;
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setError('');
    setProgress('请选择要上传的文件（每个最多 25 MiB）。');
    try {
      const {pickAndUploadAttachment} = await import('../services/attachmentPicker');
      const upload = await pickAndUploadAttachment({
        desktopId, request, signal: active.signal,
        onProgress: value => {
          if (mounted.current) setProgress(`${value.stage === 'hashing' ? '校验' : '上传'} ${Math.round(value.bytes / value.total * 100)}%`);
        },
      });
      if (upload && !active.signal.aborted && mounted.current) {
        records.current = [...records.current, upload];
        setUploads(records.current);
      } else if (upload) {
        await request(desktopId, 'attachment.abort', {uploadId: upload.uploadId}).catch(() => undefined);
      }
    } catch (cause) {
      if (mounted.current && !active.signal.aborted) setError(cause instanceof Error ? cause.message : '附件上传失败。');
    } finally {
      if (controller.current === active) controller.current = null;
      if (mounted.current) {
        setBusy(false);
        setProgress('');
      }
    }
  }, [desktopId, request]);

  const addAudioCapture = useCallback(async (capture: {captureId: string; name: string; type: string; size: number; durationMs: number}) => {
    if (controller.current || records.current.length >= 8 || !mounted.current) {
      const {MediaCapture} = await import('../native/MediaCapture');
      await MediaCapture.deleteCapture(capture.captureId).catch(() => undefined);
      return;
    }
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setError('');
    try {
      const {uploadAudioCapture} = await import('../services/mediaAttachment');
      const upload = await uploadAudioCapture({
        desktopId, request, capture, signal: active.signal,
        onProgress: value => { if (mounted.current) setProgress(`${value.stage === 'hashing' ? '校验录音' : '上传录音'} ${Math.round(value.bytes / value.total * 100)}%`); },
      });
      if (!active.signal.aborted && mounted.current) {
        records.current = [...records.current, upload];
        setUploads(records.current);
      } else {
        await request(desktopId, 'attachment.abort', {uploadId: upload.uploadId}).catch(() => undefined);
      }
    } catch (cause) {
      if (mounted.current && !active.signal.aborted) setError(cause instanceof Error ? cause.message : '录音上传失败。');
    } finally {
      if (controller.current === active) controller.current = null;
      if (mounted.current) { setBusy(false); setProgress(''); }
    }
  }, [desktopId, request]);


  const addCapturedUpload = useCallback((upload: RemoteUpload) => {
    if (!upload || records.current.some(item => item.uploadId === upload.uploadId) || records.current.length >= 8) return;
    records.current = [...records.current, upload];
    setUploads(records.current);
  }, []);


  const remove = useCallback(async (uploadId: string) => {
    records.current = records.current.filter(item => item.uploadId !== uploadId);
    setUploads(records.current);
    await request(desktopId, 'attachment.abort', {uploadId}).catch(() => undefined);
  }, [desktopId, request]);

  const markSubmitted = useCallback(() => {
    // Accepted/uncertain sends own these IDs now. Never abort or resubmit them.
    records.current = [];
    setUploads([]);
  }, []);

  return {
    uploads, busy, progress, error, add, addAudioCapture, addCapturedUpload, remove, markSubmitted,
    cancel: () => controller.current?.abort(),
  };
}
