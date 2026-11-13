(function () {
  const { net, state } = DX;
  const notifications = new Map([
    ['asset_library_updated', 'assets'],
    ['canvas_updated', 'canvas'],
  ]);
  let active;

  function disconnect(connection) {
    clearTimeout(connection.retry);
    clearInterval(connection.heartbeat);
    const ws = connection.ws;
    connection.ws = null;
    if (ws && ws.readyState < 2) {
      try {
        ws.close();
      } catch (_) {
        // The transport is already detached from this subscription.
      }
    }
  }

  function closeSocket() {
    const previous = active;
    active = null;
    if (previous) disconnect(previous);
  }

  function reconnect(connection) {
    if (active !== connection || !state.connected || !connection.handlers.isLive()) return;
    connection.missedChanges = true;
    clearTimeout(connection.retry);
    connection.retry = setTimeout(() => connect(connection), connection.delay);
    connection.delay = Math.min(connection.delay * 2, 8000);
  }

  function connect(connection) {
    if (active !== connection || !state.connected || !connection.handlers.isLive()) return;
    let ws;
    try {
      ws = new WebSocket(net.wsBase() + '/ws/stats');
    } catch (_) {
      reconnect(connection);
      return;
    }
    connection.ws = ws;
    const current = () => active === connection && connection.ws === ws;

    function ended() {
      if (!current()) return;
      disconnect(connection);
      reconnect(connection);
    }

    ws.addEventListener('open', () => {
      if (!current()) return;
      connection.delay = 1000;
      connection.heartbeat = setInterval(() => {
        try {
          ws.send('ping');
        } catch (_) {
          ended();
        }
      }, 15000);
      // Changes made while the socket was closed need a fresh catalog read.
      if (connection.missedChanges) {
        connection.missedChanges = false;
        connection.handlers.onUpdate();
      }
    });

    ws.addEventListener('message', (event) => {
      if (!current()) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      const source = notifications.get(message?.type);
      if (source) connection.handlers.onUpdate(source);
    });
    ws.addEventListener('close', ended);
    ws.addEventListener('error', ended);
  }

  function openSocket(handlers) {
    closeSocket();
    const connection = { handlers, delay: 1000 };
    active = connection;
    connect(connection);
  }

  DX.socket = { openSocket, closeSocket };
})();
