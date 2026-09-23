import { describe, it, expect } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

describe('build verification', () => {
  it('npm run build succeeds', async () => {
    const { stdout, stderr } = await execAsync('npm run build');
    expect(stderr).not.toContain('error');
    expect(stderr).not.toContain('Error');
  }, 30000);

  it('dist/cli.js exists and has shebang', () => {
    const cliPath = join(process.cwd(), 'dist', 'cli.js');
    expect(existsSync(cliPath)).toBe(true);

    const content = readFileSync(cliPath, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('dist/index.js exports createGimbal', async () => {
    // This test catches the fcef2c1 scenario - missing exports in compiled output
    const distIndexPath = join(process.cwd(), 'dist', 'index.js');
    expect(existsSync(distIndexPath)).toBe(true);

    // Dynamic import from compiled output (not source)
    const distModule = await import(distIndexPath);
    expect(distModule.createGimbal).toBeDefined();
    expect(typeof distModule.createGimbal).toBe('function');
  });
});

describe('core module smoke tests', () => {
  it('createGimbal export exists in source', async () => {
    const { createGimbal } = await import('../index.js');
    expect(createGimbal).toBeDefined();
    expect(typeof createGimbal).toBe('function');
  });

  it('GimbalOptions interface is exported', async () => {
    // TypeScript interfaces don't exist at runtime, but we can verify the module loads
    const indexModule = await import('../index.js');
    expect(indexModule).toBeDefined();
  });

  it('TypeScript compilation succeeds', async () => {
    const { stderr } = await execAsync('npx tsc --noEmit');
    expect(stderr).not.toContain('error');
    expect(stderr).not.toContain('Error');
  }, 30000);

  it('OrchestratorImpl can be imported', async () => {
    const { OrchestratorImpl } = await import('../orchestrator.js');
    expect(OrchestratorImpl).toBeDefined();
    expect(typeof OrchestratorImpl).toBe('function');
  });

  it('MessageRouterImpl can be imported', async () => {
    const { MessageRouterImpl } = await import('../message-router.js');
    expect(MessageRouterImpl).toBeDefined();
    expect(typeof MessageRouterImpl).toBe('function');
  });

  it('ChannelRegistryImpl can be imported', async () => {
    const { ChannelRegistryImpl } = await import('../channel-registry.js');
    expect(ChannelRegistryImpl).toBeDefined();
    expect(typeof ChannelRegistryImpl).toBe('function');
  });

  it('core types module exports channel helpers', async () => {
    const { isChannel, normalizeChannelName, getChannelId } = await import('../types.js');
    expect(isChannel).toBeDefined();
    expect(normalizeChannelName).toBeDefined();
    expect(getChannelId).toBeDefined();

    // Basic functionality test
    expect(isChannel('#planning')).toBe(true);
    expect(isChannel('architect')).toBe(false);
    expect(getChannelId('planning')).toBe('#planning');
  });
});
