# Disposable HTTPS fixture

The certificate and private key in this directory are public test material, never
production credentials. The CSRF browser tests use a loopback HTTPS server and pin
trust to this certificate's SPKI through a temporary Chromium launch argument.
They restore the argument after each case. No global TLS verification is disabled.

HTTPS is necessary to exercise real Secure/SameSite=None cookie behavior on
cross-site POSTs. Do not replace the fixture with HTTP or inject cookies into the
attack request: that would stop testing actual browser CSRF behavior.
