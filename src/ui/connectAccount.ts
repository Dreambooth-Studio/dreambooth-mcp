import { brandMark, widgetDocument } from "./shell.js";

/**
 * The connect card.
 *
 * Replaces a bare URL the operator had to copy out of a chat message with a
 * button, and — more importantly — with a card that *notices* when they have
 * finished approving. Before this, the only way to find out was to ask another
 * question and see whether it worked.
 *
 * Four states, driven by `connection_status`:
 *   idle       nothing started, show the button
 *   waiting    link opened, poll and count up
 *   connected  green, name the account, stop polling
 *   expired    the 5-minute state died, offer a retry
 */

export const CONNECT_WIDGET_URI = "ui://widget/connect-account.html";

const BODY = `
<div class="db-card" id="card">
  ${brandMark()}
  <div id="content"></div>
</div>
`;

/**
 * No template literals below — this file is one, and `${` inside the widget
 * script would be interpolated at build time instead of reaching the browser.
 */
const SCRIPT = `
(function () {
  var db = window.__db;
  var el = document.getElementById("content");

  var COPY = {
    id: {
      title: "Hubungkan akun Dreambooth",
      sub: "Setujui lewat Google untuk melihat data booth Anda di sini.",
      cta: "Hubungkan dengan Google",
      note: "Belum punya akun? Menyetujui otomatis membuatkannya, lengkap dengan uji coba Pro 14 hari.",
      waiting: "Menunggu persetujuan di browser",
      reopen: "Buka lagi",
      connected: "Tersambung sebagai",
      connectedPlain: "Akun Dreambooth tersambung.",
      expired: "Tautan kedaluwarsa sebelum disetujui.",
      retry: "Minta tautan baru",
      retryHint: "Minta asisten menjalankan connect_account sekali lagi untuk mendapat tautan baru.",
      noLink: "Tautan tidak tersedia. Minta asisten menjalankan connect_account sekali lagi.",
      manual: "Kalau tombolnya tidak membuka apa pun, salin tautan ini:"
    },
    en: {
      title: "Connect your Dreambooth account",
      sub: "Approve with Google to see your booth data here.",
      cta: "Continue with Google",
      note: "No account yet? Approving creates one, with a 14-day Pro trial.",
      waiting: "Waiting for approval in your browser",
      reopen: "Open again",
      connected: "Connected as",
      connectedPlain: "Dreambooth account connected.",
      expired: "The link expired before it was approved.",
      retry: "Get a new link",
      retryHint: "Ask the assistant to run connect_account again for a fresh link.",
      noLink: "No link available. Ask the assistant to run connect_account again.",
      manual: "If the button opens nothing, copy this link:"
    },
    es: {
      title: "Conecta tu cuenta de Dreambooth",
      sub: "Aprueba con Google para ver los datos de tus cabinas aqui.",
      cta: "Continuar con Google",
      note: "Aun no tienes cuenta? Al aprobar se crea una, con 14 dias de prueba Pro.",
      waiting: "Esperando aprobacion en tu navegador",
      reopen: "Abrir de nuevo",
      connected: "Conectado como",
      connectedPlain: "Cuenta de Dreambooth conectada.",
      expired: "El enlace caduco antes de aprobarse.",
      retry: "Pedir un enlace nuevo",
      retryHint: "Pide al asistente que ejecute connect_account otra vez para un enlace nuevo.",
      noLink: "No hay enlace. Pide al asistente que ejecute connect_account otra vez.",
      manual: "Si el boton no abre nada, copia este enlace:"
    }
  };

  var t = db.t(COPY);

  // Matches POLL_CEILING_MS in src/auth/deviceFlow.ts. The server stops polling
  // the Studio at five minutes; a card that kept spinning past that would be
  // waiting for something that can no longer happen.
  var CEILING_MS = 5 * 60 * 1000;
  var POLL_MS = 2000;

  var out = db.toolOutput();
  var authUrl = out.authUrl || null;
  var saved = db.getState();

  // Declared before the restore below, which reads it: a hoisted var would be
  // in scope, but its later initialiser would clobber the restored value.
  var email = out.email || null;

  // Restored from widget state, not just from the tool output: the card is
  // re-rendered whenever the operator scrolls back to it, and without this a
  // flow already halfway through would silently reset to the start.
  var phase = out.status === "already_connected" ? "connected" : "idle";
  var startedAt = null;
  if (saved.phase === "waiting" && saved.startedAt) {
    phase = "waiting";
    startedAt = saved.startedAt;
  } else if (saved.phase === "expired") {
    phase = "expired";
  } else if (saved.phase === "connected") {
    phase = "connected";
    email = email || saved.email || null;
  }

  var timer = null;
  var ticker = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  function render() {
    if (phase === "connected") {
      el.innerHTML =
        '<div class="db-status db-status--ok">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8.5l4 4 8-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span>' + (email ? esc(t.connected) + " " + esc(email) : esc(t.connectedPlain)) + '</span>' +
        '</div>';
      db.fit();
      return;
    }

    if (phase === "waiting") {
      var seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      el.innerHTML =
        '<p class="db-title">' + esc(t.title) + '</p>' +
        '<div class="db-status" style="margin-top:.75rem">' +
        '<span class="db-spinner"></span>' +
        '<span style="color:var(--db-ink-muted)">' + esc(t.waiting) + ' (' + seconds + 's)</span>' +
        '</div>' +
        (authUrl ? '<p class="db-note"><a class="db-link" href="#" id="reopen">' + esc(t.reopen) + '</a></p>' : '');
      var reopen = document.getElementById("reopen");
      if (reopen) {
        reopen.addEventListener("click", function (e) {
          e.preventDefault();
          db.openExternal(authUrl);
        });
      }
      db.fit();
      return;
    }

    if (phase === "expired") {
      // Deliberately NOT a re-open of authUrl. The Studio expires the device
      // state after five minutes, so that link is dead — clicking it would
      // send the operator to a page that cannot work, and they would wait
      // another five minutes to find out. Only connect_account can mint a new
      // state, and the widget cannot call it, so ask the model to.
      el.innerHTML =
        '<p class="db-title">' + esc(t.title) + '</p>' +
        '<p class="db-status db-status--warn" style="margin:.5rem 0 .75rem">' + esc(t.expired) + '</p>' +
        '<button class="db-btn db-btn--block" id="again">' + esc(t.retry) + '</button>';
      var again = document.getElementById("again");
      again.addEventListener("click", function () {
        var asked = db.followUp(
          "Tautan masuk Dreambooth sudah kedaluwarsa. Jalankan connect_account lagi untuk membuat tautan baru."
        );
        if (!asked) {
          again.disabled = true;
          el.insertAdjacentHTML("beforeend", '<p class="db-note">' + esc(t.retryHint) + '</p>');
          db.fit();
        }
      });
      db.fit();
      return;
    }

    el.innerHTML =
      '<p class="db-title">' + esc(t.title) + '</p>' +
      '<p class="db-sub">' + esc(t.sub) + '</p>' +
      (authUrl
        ? '<button class="db-btn db-btn--block" id="cta" style="margin-top:1rem">' + esc(t.cta) + '</button>' +
          '<p class="db-note">' + esc(t.note) + '</p>'
        : '<p class="db-note">' + esc(t.noLink) + '</p>');
    wireCta();
    db.fit();
  }

  function wireCta() {
    var cta = document.getElementById("cta");
    if (!cta) return;
    cta.addEventListener("click", function () {
      var opened = db.openExternal(authUrl);
      if (!opened) {
        // Neither the host bridge nor window.open worked. Show the URL rather
        // than leaving a button that silently does nothing.
        el.insertAdjacentHTML(
          "beforeend",
          '<p class="db-note">' + esc(t.manual) + '<br><a class="db-link" href="' + esc(authUrl) + '" target="_blank" rel="noopener">' + esc(authUrl) + '</a></p>'
        );
        db.fit();
      }
      startWaiting();
    });
  }

  function startWaiting() {
    phase = "waiting";
    startedAt = Date.now();
    db.setState({ phase: phase, startedAt: startedAt });
    render();
    stop();
    ticker = setInterval(render, 1000);
    timer = setInterval(poll, POLL_MS);
  }

  function poll() {
    if (Date.now() - startedAt > CEILING_MS) {
      stop();
      phase = "expired";
      db.setState({ phase: phase });
      render();
      return;
    }

    db.callTool("connection_status", {}).then(
      function (status) {
        if (!status) return;
        if (status.connected) {
          stop();
          phase = "connected";
          email = status.email || email;
          db.setState({ phase: phase, email: email });
          render();
          return;
        }
        if (status.phase === "expired") {
          stop();
          phase = "expired";
          db.setState({ phase: phase });
          render();
        }
      },
      function () {
        // A failed poll is not a failed connection — the next tick retries, and
        // the ceiling above is what eventually gives up.
      }
    );
  }

  // Re-resolve the copy, not just re-render: t was captured at start-up, so a
  // host that switches locale mid-conversation would otherwise keep rendering
  // the language the card first loaded in.
  db.onGlobals = function () {
    t = db.t(COPY);
    render();
  };

  render();
  if (phase === "waiting") {
    ticker = setInterval(render, 1000);
    timer = setInterval(poll, POLL_MS);
  }
})();
`;

export const connectAccountWidgetHtml = widgetDocument({
  title: "Hubungkan akun Dreambooth",
  body: BODY,
  script: SCRIPT,
});
