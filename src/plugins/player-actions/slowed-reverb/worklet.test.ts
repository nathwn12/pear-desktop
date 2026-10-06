import { runInNewContext } from 'node:vm';

import { test, expect } from '@playwright/test';

import { DATTORRO_WORKLET_SOURCE } from './worklet';

/**
 * The worklet source is a string executed in an AudioWorkletGlobalScope, so it
 * is evaluated here in a `vm` context with the three globals that scope
 * provides. The real port boundary is exercised: the processor's constructor
 * wires `port.onmessage` to `handleMessage`, so a message posted through the
 * port must retire it.
 */
interface WorkletProcessor {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

function createProcessor(sampleRate: number): WorkletProcessor {
  const registered: Array<new () => WorkletProcessor> = [];
  runInNewContext(DATTORRO_WORKLET_SOURCE, {
    sampleRate,
    AudioWorkletProcessor: class {
      port = { onmessage: null };
    },
    registerProcessor: (_name: string, value: new () => WorkletProcessor) => {
      registered.push(value);
    },
  });
  const Processor = registered[0];
  if (!Processor) throw new Error('worklet did not register a processor');
  return new Processor();
}

test('the processor returns false after an owned dispose message reaches its port', () => {
  const dsp = createProcessor(48000);
  const inputs = [[new Float32Array(128)]];
  const outputs = [[new Float32Array(128), new Float32Array(128)]];

  // Positive control: the processor is live before the handshake, so the false
  // below proves the dispose took effect rather than the object being dead.
  expect(dsp.process(inputs, outputs)).toBe(true);

  dsp.port.onmessage?.({ data: { type: 'dispose' } });

  expect(dsp.process(inputs, outputs)).toBe(false);
});
