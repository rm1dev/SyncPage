export type NodeRole = 'MASTER' | 'EDGE';

export function getNodeRole(): NodeRole {
  const role = (process.env.NODE_ROLE || 'MASTER').toUpperCase();
  // SLAVE رو برای سازگاری موقت هنوز قبول می‌کنیم
  return role === 'EDGE' || role === 'SLAVE' ? 'EDGE' : 'MASTER';
}

export function isMaster(): boolean {
  return getNodeRole() === 'MASTER';
}

export function isEdge(): boolean {
  return getNodeRole() === 'EDGE';
}
