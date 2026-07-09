import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateOpenApiTests } from '../src/generate-command.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(__dirname, 'fixtures', 'openapi', name);

// Scaffolding a static file must not bake a `{{uuid}}`/`{{timestamp}}`/
// `{{shortId}}` example into a single frozen value - that would replay the
// exact same value every time the generated file is run, which breaks
// "must not already exist" endpoints (e.g. signup) on any run after the
// first. The generated file should instead carry its own beforeSend that
// re-rolls those tokens on every send.
test('generateOpenApiTests wires a self-contained beforeSend for tests with generator placeholders', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'spectest-generate-'));
  try {
    const [filePath] = await generateOpenApiTests(fixture('generators.yaml'), outputDir, {});
    const contents = await readFile(filePath, 'utf8');

    // The scaffold keeps the tokens literal in the serialized example...
    assert.match(contents, /"id": "\{\{uuid\}\}"/);
    assert.match(contents, /"createdAt": "\{\{timestamp\}\}"/);
    assert.match(contents, /"slug": "\{\{shortId\}\}"/);
    // ...and wires a real (unquoted, executable) beforeSend reference, not a dropped-hook TODO comment.
    assert.match(contents, /beforeSend: __spectestRegenerateExampleData/);
    assert.doesNotMatch(contents, /TODO: this generated test had a/);
    // The helper itself must be defined in the file so it's runnable standalone.
    assert.match(contents, /function __spectestRegenerateExampleData/);

    const mod = await import(filePath);
    const widget = mod.default.tests.find((t: any) => t.operationId === 'createWidget');
    assert.equal(typeof widget.beforeSend, 'function');
    const resolved = widget.beforeSend({ url: '/widgets', headers: {}, data: widget.request.body });
    assert.notEqual(resolved.data.id, '{{uuid}}');
    assert.notEqual(resolved.data.createdAt, '{{timestamp}}');
    assert.notEqual(resolved.data.slug, '{{shortId}}');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
