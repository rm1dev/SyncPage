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

  packageLandingZip(slug: string, fileName = `${slug}.zip`): string {
    const source = join(this.staticRoot, slug);
    if (!existsSync(source)) {
      throw new Error(`Landing directory not found: ${slug}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*\.zip$/i.test(fileName)) {
      throw new Error('Invalid package filename');
    }

    const outDir = join(this.tempRoot, 'packages');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, fileName);

    if (existsSync(outPath)) {
      rmSync(outPath, { force: true });
    }

    const zip = new AdmZip();
    zip.addLocalFolder(source);
    zip.writeZip(outPath);
    return outPath;
  }

  /**
   * Builds an immutable package for a landing version. A later save must never
   * replace the bytes that a queued edge sync event refers to.
   */
  createImmutableLandingPackage(
    slug: string,
    version: number,
  ): { path: string; checksum: string; fileName: string } {
    const draftName = `${slug}-v${version}-${Date.now()}.zip`;
    const draftPath = this.packageLandingZip(slug, draftName);
    const checksum = this.checksumFile(draftPath);
    const fileName = `${slug}-v${version}-${checksum}.zip`;
    const finalPath = join(this.tempRoot, 'packages', fileName);

    if (existsSync(finalPath)) {
      rmSync(draftPath, { force: true });
    } else {
      renameSync(draftPath, finalPath);
    }

    return { path: finalPath, checksum, fileName };
  }

  cleanPreview(previewId: string) {
    const dir = join(this.tempRoot, 'preview', previewId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  //  Landing File Manager
  // -------------------------------------------------------------------

  /** جلوگیری از path traversal — مسیر باید داخل پوشه لندینگ باشه */
  private resolveSafePath(slug: string, relPath: string): string {
    if (!/^[a-z0-9-_]+$/i.test(slug)) {
      throw new Error('Invalid slug');
    }
    const base = join(this.staticRoot, slug);
    const resolved = join(base, relPath);
    if (!resolved.startsWith(base)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  /** ساختار درختی فایل‌های لندینگ */
  listLandingFiles(slug: string): FileTreeNode[] {
    const base = join(this.staticRoot, slug);
    if (!existsSync(base)) return [];
    return this.buildTree(base, '');
  }

  private buildTree(absDir: string, relDir: string): FileTreeNode[] {
    const entries = readdirSync(absDir, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];
    for (const entry of entries) {
      if (entry.name === '.syncpage-meta.json') continue;
      if (entry.name === '.DS_Store') continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          type: 'directory',
          path: relPath,
          children: this.buildTree(absPath, relPath),
        });
      } else {
        const stat = statSync(absPath);
        nodes.push({
          name: entry.name,
          type: 'file',
          path: relPath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
    // پوشه‌ها اول، بعد فایل‌ها — مرتب بر اساس نام
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /** خواندن محتوای فایل */
  readLandingFile(
    slug: string,
    relPath: string,
  ): { content: string; size: number } {
    const absPath = this.resolveSafePath(slug, relPath);
    if (!existsSync(absPath)) throw new Error('File not found');
    const stat = statSync(absPath);
    if (stat.isDirectory()) throw new Error('Path is a directory');
    if (stat.size > 5 * 1024 * 1024)
      throw new Error('File too large to edit (max 5MB)');
    const content = readFileSync(absPath, 'utf8');
    return { content, size: stat.size };
  }

  /** ذخیره محتوای فایل */
  writeLandingFile(slug: string, relPath: string, content: string): void {
    const absPath = this.resolveSafePath(slug, relPath);
    if (!existsSync(absPath)) throw new Error('File not found');
    if (statSync(absPath).isDirectory()) throw new Error('Path is a directory');
    writeFileSync(absPath, content, 'utf8');

    // فایل ZIP پکیج رو هم آپدیت/پاک می‌کنیم تا دفعه بعد که دانلود میشه فایل‌های جدید توش باشه
    const packageZip = join(this.tempRoot, 'packages', `${slug}.zip`);
    if (existsSync(packageZip)) {
      rmSync(packageZip, { force: true });
    }
  }

  /** مسیر فیزیکی فایل برای دانلود */
  getLandingFilePath(slug: string, relPath: string): string {
    const absPath = this.resolveSafePath(slug, relPath);
    if (!existsSync(absPath)) throw new Error('File not found');
    if (statSync(absPath).isDirectory()) throw new Error('Path is a directory');
    return absPath;
  }
}

export interface FileTreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  modifiedAt?: string;
  children?: FileTreeNode[];
}
