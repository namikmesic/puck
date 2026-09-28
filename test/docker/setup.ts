import { buildTestBundle, buildTestImage } from './helpers';

/** Once per suite run: the fake-harness bundle and the test image. */
export default async function setup(): Promise<void> {
  buildTestBundle();
  await buildTestImage();
}
