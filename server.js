const http = require("http");
const crypto = require("crypto");

const port = process.env.PORT || 3000;

// ---- 環境変数（Azure App Service のアプリ設定で指定する）----
const CONSUME_HANDOFF_URL = process.env.CONSUME_HANDOFF_URL || "";
const HANDOFF_SHARED_SECRET = process.env.HANDOFF_SHARED_SECRET || "";
const EXTERNAL_ISSUER = process.env.EXTERNAL_ISSUER || "aws-cognito";

// ---- 簡易セッション（検証用のメモリ保存）----
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

function createSession(user) {
  const sid = crypto.randomBytes(32).toString("hex");
  sessions.set(sid, {
    user,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return sid;
}

function getSession(request) {
  const cookie = request.headers.cookie || "";
  const hit = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("handoff_sid="));

  if (!hit) return null;

  const sid = hit.slice("handoff_sid=".length);
  const session = sessions.get(sid);

  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }

  return session;
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]
  );
}

function page(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="font-family:sans-serif;padding:2rem;line-height:1.8">${bodyHtml}</body></html>`;
}

function send(response, status, html) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(html);
}

function createServer() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );

    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");

    // ---------- トップ ----------
    if (requestUrl.pathname === "/") {
      return send(
        response,
        200,
        page(
          "Azureハンドオフ",
          `
          <h1>Azureハンドオフアプリプラス</h1>
          <p>Azure App Serviceで正常に動作しています。</p>
          <p>AWS Webアプリの「Azureへ移動」から遷移してください。</p>`
        )
      );
    }

    // ---------- 死活確認 ----------
    if (requestUrl.pathname === "/healthz") {
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return response.end("ok");
    }

    // ---------- GET /handoff ----------
    if (requestUrl.pathname === "/handoff") {
      const code = requestUrl.searchParams.get("code");

      if (!code) {
        return send(
          response,
          400,
          page(
            "エラー",
            `
            <h1>ハンドオフエラー</h1>
            <p>ハンドオフコードが指定されていません。</p>
            <p><a href="/">トップへ戻る</a></p>`
          )
        );
      }

      if (!CONSUME_HANDOFF_URL) {
        return send(
          response,
          500,
          page(
            "エラー",
            `
            <h1>設定エラー</h1>
            <p>サーバー設定が不足しています。</p>
            <p><a href="/">トップへ戻る</a></p>`
          )
        );
      }

      let data = null;

      try {
        // AzureサーバーからAWSのAPIをサーバー間で呼び出す
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        let consumeResponse;

        try {
          consumeResponse = await fetch(CONSUME_HANDOFF_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-handoff-secret": HANDOFF_SHARED_SECRET
            },
            body: JSON.stringify({ code }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }

        data = await consumeResponse.json().catch(() => null);

        if (
          !consumeResponse.ok ||
          !data ||
          data.valid !== true
        ) {
          // 存在しない・期限切れ・使用済みを出し分けない
          return send(
            response,
            401,
            page(
              "エラー",
              `
              <h1>ハンドオフ失敗</h1>
              <p>このリンクは無効か、期限切れか、すでに使用済みです。</p>
              <p><a href="/">トップへ戻る</a></p>`
            )
          );
        }
      } catch (error) {
        // handoffCode は絶対にログへ出さない
        console.error("consume-handoff call failed:", error.name);

        return send(
          response,
          502,
          page(
            "エラー",
            `
            <h1>接続エラー</h1>
            <p>認証サーバーへ接続できませんでした。時間をおいて再度お試しください。</p>
            <p><a href="/">トップへ戻る</a></p>`
          )
        );
      }

      // 新しい Session ID を発行（セッション固定対策）
      const sid = createSession({
        externalIssuer: EXTERNAL_ISSUER,
        externalSubject: data.sub,
        email: data.email,
        name: data.name,
        authenticatedAt: new Date().toISOString()
      });

      // URL から code を除去するためリダイレクト
      response.writeHead(302, {
        Location: "/handoff-complete",
        "Set-Cookie": `handoff_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
      });
      return response.end();
    }

    // ---------- GET /handoff-complete ----------
    if (requestUrl.pathname === "/handoff-complete") {
      const session = getSession(request);

      if (!session) {
        return send(
          response,
          401,
          page(
            "エラー",
            `
            <h1>未認証</h1>
            <p>未認証、またはセッションの有効期限が切れています。</p>
            <p><a href="/">トップへ戻る</a></p>`
          )
        );
      }

      return send(
        response,
        200,
        page(
          "ハンドオフ完了",
          `
          <h1>ハンドオフ成功</h1>
          <p>名前：${escapeHtml(session.user.name)}</p>
          <p>メール：${escapeHtml(session.user.email)}</p>
          <p><a href="/logout">ログアウト</a></p>`
        )
      );
    }

    // ---------- ログアウト ----------
    if (requestUrl.pathname === "/logout") {
      const cookie = request.headers.cookie || "";
      const hit = cookie
        .split(";")
        .map((value) => value.trim())
        .find((value) => value.startsWith("handoff_sid="));

      if (hit) {
        sessions.delete(hit.slice("handoff_sid=".length));
      }

      response.writeHead(302, {
        Location: "/",
        "Set-Cookie": "handoff_sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
      });
      return response.end();
    }

    // ---------- 404 ----------
    return send(
      response,
      404,
      page(
        "404",
        `
        <h1>ページが見つかりません</h1>
        <p><a href="/">トップへ戻る</a></p>`
      )
    );
  });
}

// node server.js で直接実行した場合だけ待ち受けを開始する。
// テストから require("../server") した場合は自動起動しない。
if (require.main === module) {
  const server = createServer();

  server.listen(port, "0.0.0.0", () => {
    console.log(`Server started on port ${port}`);
  });
}

module.exports = {
  createServer
};
