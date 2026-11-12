/**
 * Private-network hosts the dev server answers to, so a tablet or phone on the LAN can use it.
 * Development only: Next.js reads these as `allowedDevOrigins`, Better Auth as extra allowed hosts.
 * Patterns are hostnames without a port; `*` stands for one label.
 */
export const lanDevHosts = ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"];
