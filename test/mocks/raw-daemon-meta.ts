/** Metadata of the stand-in bundle in raw-daemon.ts (build = its sha256). */
import { createHash } from 'node:crypto';
import source from './raw-daemon';

export default { version: '0.0.0-test', build: createHash('sha256').update(source).digest('hex') };
