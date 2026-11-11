/* Sign in on this site with a passkey. The site's own server brokers the ceremony and Network verifies it
   (WebAuthn Related Origin Requests). A browser without them, or a person without a key, keeps the ordinary
   OpenVibe sign-in: this only takes over the Sign In control after the browser says it supports related origins. */
(function () {
    'use strict';
    if (!window.PublicKeyCredential || !PublicKeyCredential.getClientCapabilities) return;
    var b64 = function (buf) {
        var s = String.fromCharCode.apply(null, new Uint8Array(buf));
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    var bytes = function (value) {
        var raw = atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    };
    var post = function (url, body) {
        return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (res) {
                return res.json().then(function (data) { if (!res.ok) throw new Error(data.error_description || data.error || 'Sign-in failed'); return data; });
            });
    };
    var nextOf = function (href) {
        try { var next = new URL(href, location.href).searchParams.get('next'); return next && next.charAt(0) === '/' ? next : '/'; } catch (e) { return '/'; }
    };
    var signIn = async function (login) {
        try {
            var start = await post('/auth/passkey/options', {});
            var options = start.options;
            options.challenge = bytes(options.challenge);
            if (options.allowCredentials) options.allowCredentials = options.allowCredentials.map(function (c) { return Object.assign({}, c, { id: bytes(c.id) }); });
            var credential = await navigator.credentials.get({ publicKey: options });
            var done = await post('/auth/passkey/verify', {
                state: start.state,
                response: {
                    id: credential.id, rawId: b64(credential.rawId), type: credential.type,
                    clientExtensionResults: credential.getClientExtensionResults(),
                    response: {
                        clientDataJSON: b64(credential.response.clientDataJSON),
                        authenticatorData: b64(credential.response.authenticatorData),
                        signature: b64(credential.response.signature),
                        userHandle: credential.response.userHandle ? b64(credential.response.userHandle) : null,
                    },
                },
            });
            if (done.ok) location.href = nextOf(login.href);
        } catch (err) {
            // No key on this device, a cancelled prompt or a site not ready: the ordinary sign-in still works.
            location.href = login.href;
        }
    };
    PublicKeyCredential.getClientCapabilities().then(function (caps) {
        if (!caps || !caps.relatedOrigins) return;
        document.addEventListener('click', function (event) {
            var login = event.target.closest && event.target.closest('#openvibe-login-btn');
            if (!login || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            signIn(login);
        }, true);
    }).catch(function () { /* keep the ordinary sign-in */ });
})();
