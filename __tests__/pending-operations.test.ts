const mockSecrets = new Map<string, string>();
let mockFailWrite = false;
jest.mock('react-native-keychain', () => ({
 ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device'}, SECURITY_LEVEL: {SECURE_SOFTWARE: 'software'},
 getGenericPassword: jest.fn(async ({service}) => mockSecrets.has(service) ? {password: mockSecrets.get(service)} : false),
 setGenericPassword: jest.fn(async (_name, password, {service}) => {if (mockFailWrite) return false; mockSecrets.set(service, password); return true;}),
}));
import {updatePendingOperations} from '../src/services/secureStore';
beforeEach(() => {mockSecrets.clear(); mockFailWrite = false;});
it('serializes concurrent additions, restores pending IDs and removes settled operations', async () => {
 const a = {operationId: 'command-a-fixture', conversationId: 'conversation-pending-fixture', issuedAt: 1234};
 const b = {...a, operationId: 'command-b-fixture'};
 await Promise.all([updatePendingOperations('desktop-pending-fixture', items => [...items, a]), updatePendingOperations('desktop-pending-fixture', items => [...items, b])]);
 expect(await updatePendingOperations('desktop-pending-fixture', items => items)).toEqual([a, b]);
 expect(await updatePendingOperations('desktop-pending-fixture', items => items.filter(item => item.operationId !== a.operationId))).toEqual([b]);
 expect(await updatePendingOperations('different-desktop-fixture', items => items)).toEqual([]);
 const disk = [...mockSecrets.values()].join('');
 expect(disk).not.toContain('text'); expect(disk).not.toContain('params');
});
it('propagates secure-store failure and never silently drops pending records for capacity', async () => {
 mockFailWrite = true;
 await expect(updatePendingOperations('desktop-failure-fixture', items => [...items, {operationId: 'pending-fixture', conversationId: null, issuedAt: 1}])).rejects.toThrow();
 mockFailWrite = false;
 const items = await updatePendingOperations('desktop-failure-fixture', () => Array.from({length: 1024}, (_, i) => ({operationId: `pending-${i}`, conversationId: null, issuedAt: 1})));
 expect(items).toHaveLength(1024);
 expect(await updatePendingOperations('desktop-failure-fixture', current => current)).toEqual(items);
 await Promise.all([updatePendingOperations('desktop-failure-fixture', current => [...current, {operationId: 'extra', conversationId: null, issuedAt: 2}]), updatePendingOperations('desktop-failure-fixture', current => current.filter(item => item.operationId !== 'pending-0'))]);
 expect(await updatePendingOperations('desktop-failure-fixture', current => current)).toHaveLength(1024);
});
