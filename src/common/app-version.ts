import { readFileSync } from 'fs';
import { join } from 'path';

/** نسخهٔ لوکال از package.json داخل ایمیج/ریپو */
export function getLocalVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return String(pkg.version || '0.0.0').replace(/^v/i, '');
  } catch {
    return String(process.env.npm_package_version || '0.0.0').replace(
      /^v/i,
      '',
    );
  }
}

/** مقایسه semver ساده: منفی = a < b ، صفر = برابر ، مثبت = a > b */
export function compareSemver(a: string, b: string): number {
  const pa = a
    .replace(/^v/i, '')
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
  const pb = b
    .replace(/^v/i, '')
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isOutdated(local: string, latest: string): boolean {
  if (!local || !latest) return false;
  return compareSemver(local, latest) < 0;
}
