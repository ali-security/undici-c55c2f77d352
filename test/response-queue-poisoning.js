'use strict'

const assert = require('node:assert')
const { createServer } = require('node:http')
const { createServer: createNetServer } = require('node:net')
const { once } = require('node:events')
const { after, test } = require('node:test')
const { Client } = require('..')

function readBody (body) {
  return new Promise((resolve, reject) => {
    let data = ''
    body.setEncoding('latin1')
    body.on('data', chunk => { data += chunk })
    body.on('end', () => resolve(data))
    body.on('error', reject)
  })
}

test('should not reuse an idle socket with buffered unsolicited response bytes', async () => {
  let evilServerSocket

  const server = createServer((req, res) => {
    if (!evilServerSocket) {
      evilServerSocket = req.socket
    }

    res.end(req.url)
  })
  after(() => server.close())

  await new Promise(resolve => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout: 300e3
  })
  after(() => client.close())

  const response1 = await client.request({ path: '/request1', method: 'GET' })
  assert.strictEqual(await readBody(response1.body), '/request1')

  const disconnected = once(client, 'disconnect')

  evilServerSocket.write(
    'HTTP/1.1 200 OK\r\n' +
    'Poison-Free-Socket: true\r\n' +
    'Connection: keep-alive\r\n' +
    'Keep-Alive: timeout=300\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n'
  )

  await disconnected

  const response2 = await client.request({ path: '/request2', method: 'GET' })
  assert.strictEqual(response2.headers['poison-free-socket'], undefined)
  assert.strictEqual(await readBody(response2.body), '/request2')
})

test('should not attribute an unsolicited pipelined response to a queued request', async () => {
  let connections = 0

  const server = createNetServer(socket => {
    const connection = ++connections

    socket.on('error', () => {})
    socket.once('data', () => {
      if (connection === 1) {
        // Answer the in-flight request and append a second, entirely
        // unsolicited response in the very same write. Both land in the
        // client's read buffer before the already queued second request can
        // be written to the socket - that is the exact window the response
        // queue poisoning attack relies on.
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Connection: keep-alive\r\n' +
          'Keep-Alive: timeout=300\r\n' +
          'Content-Length: 9\r\n' +
          '\r\n' +
          '/request1' +
          'HTTP/1.1 200 OK\r\n' +
          'Poison-Free-Socket: true\r\n' +
          'Connection: keep-alive\r\n' +
          'Keep-Alive: timeout=300\r\n' +
          'Content-Length: 8\r\n' +
          '\r\n' +
          'poisoned'
        )
      } else {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Connection: keep-alive\r\n' +
          'Keep-Alive: timeout=300\r\n' +
          'Content-Length: 9\r\n' +
          '\r\n' +
          '/request2'
        )
      }
    })
  })
  after(() => server.close())

  await new Promise(resolve => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout: 300e3
  })
  after(() => client.close())

  // Both requests are queued before a single byte is written, so the second
  // request is already sitting at the head of the queue - unwritten - by the
  // time the unsolicited response is parsed.
  const promise1 = client.request({ path: '/request1', method: 'GET' })
  const promise2 = client.request({ path: '/request2', method: 'GET' })

  const response1 = await promise1
  assert.strictEqual(await readBody(response1.body), '/request1')

  const response2 = await promise2
  assert.strictEqual(response2.headers['poison-free-socket'], undefined)
  assert.strictEqual(await readBody(response2.body), '/request2')

  // The poisoned connection must have been torn down and the queued request
  // re-dispatched on a fresh one.
  assert.strictEqual(connections, 2)
})
