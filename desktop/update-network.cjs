'use strict';

const { isAllowedUpdateUrl } = require('./updater.cjs');

function createDesktopUpdateFetch(session, { allowInsecure = false } = {}) {
  let updateSession;
  return async (url, options) => {
    if (!updateSession) {
      updateSession = session.fromPartition('xiaomei-updater');
      // Electron 31 rejects manual redirects. Guard every outgoing hop before
      // allowing Chromium to follow GitHub's asset redirects automatically.
      updateSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !isAllowedUpdateUrl(details.url, { allowInsecure }) });
      });
    }
    return updateSession.fetch(url, { ...options, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
  };
}

module.exports = { createDesktopUpdateFetch };
