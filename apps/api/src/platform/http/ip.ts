/**
 * Coarse network prefix for session listings: IPv4 -> /24, IPv6 -> /48. Full client IPs are
 * personal data and are never persisted by this service.
 */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) {
    const groups = ip.split(':').slice(0, 3);
    if (groups.length === 3 && groups.every((g) => /^[0-9a-fA-F]{0,4}$/.test(g))) {
      return `${groups.join(':')}::/48`;
    }
  }
  return null;
}
