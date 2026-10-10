# Security policy

## Supported versions

kobay is pre-1.0. Only the latest published `0.x` release of
[`@ademtfkc/kobay`](https://www.npmjs.com/package/@ademtfkc/kobay) gets
security fixes. Please check that a problem still happens on the latest
release before reporting it.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability.

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**
([direct link](https://github.com/ademtfkc/kobay/security/advisories/new)).
Include the kobay version, your OS and Node.js version, the brain you use, the
steps to reproduce and what an attacker gains.

Do not attach `trace.zip`, screenshots, a failure bundle or anything from
`.kobay/` without checking it first: traces carry session cookies and
screenshots are not redacted.

This is a small project maintained in spare time. You will get an answer, but
there is no response-time guarantee.

## Scope

In scope: a way to break a guarantee kobay states — for example credentials
sent to a site the origin lock should block, a path check that lets a file
argument escape the project, secret masking that kobay claims but does not do,
or the generated-code check letting through something it says it rejects.

Not in scope: the limits that the README's
[Security model](README.md#security-model) and
[Known limitations](README.md#known-limitations) already list. In particular,
generated tests run as your user with no sandbox, the code check is a lexical
speed bump with known escapes, the browser is not fenced, screenshots and
traces are not redacted, and the 307/308 redirect and Web Worker WebSocket
gaps of the login guard are known. Reports that make one of these worse than
described are welcome.
