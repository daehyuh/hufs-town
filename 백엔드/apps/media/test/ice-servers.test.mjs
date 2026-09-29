import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createIceServersProvider,
  parseIceServers,
} from '../src/ice-servers.mjs';

test('Coturn REST credentials are fresh, expiring and derived from the shared secret', () => {
  const secret = 'a'.repeat(64);
  let nonce = 0;
  const provider = createIceServersProvider(
    JSON.stringify([
      {
        urls: [
          'turn:turn.example.test:3478?transport=udp',
          'turns:turn.example.test:5349?transport=tcp',
        ],
      },
      { urls: 'stun:stun.example.test:3478' },
    ]),
    {
      sharedSecret: secret,
      credentialTtlSeconds: 3600,
      nowSeconds: () => 1_700_000_000,
      nonce: () => `browser-${++nonce}`,
    },
  );

  const first = provider();
  const second = provider();
  const firstUsername = '1700003600:browser-1';
  const expectedCredential = createHmac('sha1', secret)
    .update(firstUsername)
    .digest('base64');

  assert.deepEqual(first[0].urls, [
    'turn:turn.example.test:3478?transport=udp',
    'turns:turn.example.test:5349?transport=tcp',
  ]);
  assert.equal(first[0].username, firstUsername);
  assert.equal(first[0].credential, expectedCredential);
  assert.equal(second[0].username, '1700003600:browser-2');
  assert.deepEqual(first[1], { urls: ['stun:stun.example.test:3478'] });
  assert.equal(JSON.stringify(first).includes(secret), false);
});

test('static ICE credentials remain compatible and URL arrays are normalized', () => {
  assert.deepEqual(
    parseIceServers(
      JSON.stringify([
        {
          urls: ['turn:turn.example.test:3478', 'stun:stun.example.test:3478'],
          username: 'test-user',
          credential: 'test-password',
        },
      ]),
    ),
    [
      {
        urls: ['turn:turn.example.test:3478', 'stun:stun.example.test:3478'],
        username: 'test-user',
        credential: 'test-password',
      },
    ],
  );
  const provider = createIceServersProvider(
    JSON.stringify([
      {
        urls: 'turn:turn.example.test:3478',
        username: 'test-user',
        credential: 'test-password',
      },
    ]),
  );
  assert.deepEqual(provider(), [
    {
      urls: ['turn:turn.example.test:3478'],
      username: 'test-user',
      credential: 'test-password',
    },
  ]);
});

test('TURN configuration fails closed when authentication is missing or ambiguous', () => {
  assert.throws(
    () => createIceServersProvider('[{"urls":"turn:turn.example.test:3478"}]'),
    /requires MEDIA_TURN_SHARED_SECRET or static credentials/,
  );
  assert.throws(
    () =>
      createIceServersProvider(
        '[{"urls":"turn:turn.example.test:3478","username":"user"}]',
      ),
    /must be configured together/,
  );
  assert.throws(
    () =>
      createIceServersProvider('[{"urls":"turn:turn.example.test:3478"}]', {
        sharedSecret: 'too-short',
      }),
    /must contain at least 32 characters/,
  );
  assert.throws(
    () =>
      createIceServersProvider(
        '[{"urls":"turn:turn.example.test:3478","username":"user","credential":"password"}]',
        { sharedSecret: 'a'.repeat(64) },
      ),
    /cannot combine static credentials/,
  );
  assert.throws(
    () =>
      createIceServersProvider('[{"urls":"turn:turn.example.test:3478"}]', {
        sharedSecret: 'a'.repeat(64),
        credentialTtlSeconds: 59,
      }),
    /must be between 60 and 604800/,
  );
});
