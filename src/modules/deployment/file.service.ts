import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  cpSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AdmZip from 'adm-zip';

@Injectable()
export class FileService {
  constructor(private readonly config: ConfigService) {}

  get staticRoot(): string {
    return this.config.get<string>('staticPagesPath') || './static_pages';
  }

  get tempRoot(): string {
    return this.config.get<string>('tempPath') || './temp';
  }

  ensureDirs() {
    for (const dir of [
      this.staticRoot,
      join(this.tempRoot, 'preview'),
      join(this.tempRoot, 'packages'),
    ]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  extractZip(zipPath: string, targetDir: string) {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    mkdirSync(targetDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);
    this.normalizeExtractedLanding(targetDir);
  }

  /**
   * اگه ZIP یه پوشهٔ ریشه اضافه داره (مثل site/index.html)، محتوا رو میاریم بالا
   * تا پیش‌نمایش و سرو استاتیک index.html رو مستقیم ببینن
   */
  normalizeExtractedLanding(dir: string) {
    if (existsSync(join(dir, 'index.html'))) return;

    const entries = readdirSync(dir).filter(
      (e) => e !== '__MACOSX' && e !== '.DS_Store',
    );
    if (entries.length !== 1) return;

    const only = join(dir, entries[0]);
    if (!statSync(only).isDirectory()) return;
    if (!existsSync(join(only, 'index.html'))) return;

    const tmp = `${dir}.__flatten__`;
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    renameSync(only, tmp);
    for (const left of readdirSync(dir)) {
      rmSync(join(dir, left), { recursive: true, force: true });
    }
    for (const child of readdirSync(tmp)) {
      renameSync(join(tmp, child), join(dir, child));
    }
    rmSync(tmp, { recursive: true, force: true });
  }

  /**
   * توی index.html یه <base href="..."> می‌ذاریم تا assetهای absolute مثل /css/x.css
   * نسبت به مسیر لندینگ resolve بشن (نه روت دامنه)
   */
  ensureHtmlBaseHref(dir: string, baseHref: string) {
    const indexPath = join(dir, 'index.html');
    if (!existsSync(indexPath)) return;
    let html = readFileSync(indexPath, 'utf8');
    if (/<base\s/i.test(html)) return;
    const base = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
    } else {
      html = `<base href="${base}">` + html;
    }
    writeFileSync(indexPath, html);
  }

  checksumFile(filePath: string): string {
    const buf = readFileSync(filePath);
    return createHash('sha256').update(buf).digest('hex');
  }

  checksumDirMarker(slug: string, version: number, checksum: string) {
    const marker = join(this.staticRoot, slug, '.syncpage-meta.json');
    writeFileSync(
      marker,
      JSON.stringify({ slug, version, checksum, at: new Date().toISOString() }),
    );
  }

  /** جایگزینی اتمیک پوشه لندینگ (staging روی همون volume) */
  replaceLandingAtomic(slug: string, sourceDir: string) {
    const target = join(this.staticRoot, slug);
    // staging باید روی همون filesystem باشه تا rename بین volumeها نترکه
    const staging = join(this.staticRoot, `.staging-${slug}-${Date.now()}`);
    const backup = join(this.staticRoot, `.backup-${slug}-${Date.now()}`);

    cpSync(sourceDir, staging, { recursive: true });

    if (existsSync(target)) {
      renameSync(target, backup);
    }
    try {
      renameSync(staging, target);
      if (existsSync(backup)) {
        rmSync(backup, { recursive: true, force: true });
      }
    } catch (err) {
      // اگر خراب شد، بکاپ رو برگردون
      if (existsSync(backup) && !existsSync(target)) {
        renameSync(backup, target);
      }
      if (existsSync(staging)) {
        rmSync(staging, { recursive: true, force: true });
      }
      throw err;
    }
  }

  packageLandingZip(slug: string): string {
    const source = join(this.staticRoot, slug);
    if (!existsSync(source)) {
      throw new Error(`Landing directory not found: ${slug}`);
    }
    const outDir = join(this.tempRoot, 'packages');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${slug}.zip`);
    const zip = new AdmZip();
    zip.addLocalFolder(source);
    zip.writeZip(outPath);
    return outPath;
  }

  cleanPreview(previewId: string) {
    const dir = join(this.tempRoot, 'preview', previewId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
