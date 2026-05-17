// Owner-role gate unit tests. Mocks getBarbers() at the module
// boundary so we don't reach into Square.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockBarbers = vi.fn();
vi.mock('../square/team', () => ({
  getBarbers: () => mockBarbers(),
}));

import { isBarberOwner } from './barberPermissions';

beforeEach(() => {
  mockBarbers.mockReset();
});

describe('isBarberOwner', () => {
  it('returns true for the barber whose role is Owner', async () => {
    mockBarbers.mockResolvedValue([
      { id: '523GMGEC1FY0Z', role: 'Owner', displayName: 'Michael' },
      { id: 'TMmaster1', role: 'Master Barber', displayName: 'Rick' },
    ]);
    expect(await isBarberOwner('523GMGEC1FY0Z')).toBe(true);
  });

  it('returns false for a barber without the Owner role', async () => {
    mockBarbers.mockResolvedValue([
      { id: '523GMGEC1FY0Z', role: 'Owner', displayName: 'Michael' },
      { id: 'TMmaster1', role: 'Master Barber', displayName: 'Rick' },
    ]);
    expect(await isBarberOwner('TMmaster1')).toBe(false);
  });

  it('returns false for an unknown barber id', async () => {
    mockBarbers.mockResolvedValue([
      { id: '523GMGEC1FY0Z', role: 'Owner', displayName: 'Michael' },
    ]);
    expect(await isBarberOwner('TMunknown')).toBe(false);
  });

  it('returns false for an empty barber id (no implicit elevation)', async () => {
    // Should short-circuit without even calling getBarbers.
    expect(await isBarberOwner('')).toBe(false);
    expect(mockBarbers).not.toHaveBeenCalled();
  });

  it('fails closed when getBarbers throws (no implicit elevation on outage)', async () => {
    mockBarbers.mockRejectedValue(new Error('Square unavailable'));
    expect(await isBarberOwner('523GMGEC1FY0Z')).toBe(false);
  });
});
