const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");

test("GET / returns application page", async () => {
  const server = createServer();

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();

    const response = await fetch(
      `http://127.0.0.1:${address.port}/`
    );

    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Azureハンドオフアプリプラス/);

  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
});