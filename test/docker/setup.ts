import { buildRunnerBundle, buildTestBundle, buildTestImage } from './helpers';

/** Once per suite run: the fake-harness daemon bundle, the runner bundle, and the test image. */
export default async function setup(): Promise<void> {
  buildTestBundle();
  buildRunnerBundle();
  await buildTestImage();
}
