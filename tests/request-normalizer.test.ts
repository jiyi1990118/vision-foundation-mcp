import { describe, it, expect } from 'vitest';
import { isPrivateHost } from '../src/core/request-normalizer.js';

describe('isPrivateHost (SSRF mitigation)', () => {
  it('blocks loopback and localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.1.2.3')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
  });

  it('blocks link-local addresses', () => {
    expect(isPrivateHost('169.254.1.1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
  });

  it('blocks IPv6 unique-local addresses', () => {
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12:3456::1')).toBe(true);
  });

  it('allows public hosts', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false); // just outside private range
    expect(isPrivateHost('11.0.0.1')).toBe(false);
  });

  it('strips IPv6 brackets', () => {
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('[fe80::1]')).toBe(true);
  });
});
