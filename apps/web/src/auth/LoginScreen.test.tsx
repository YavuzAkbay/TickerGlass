import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthMethod } from '../api/auth';
import { LoginView } from './LoginScreen';

const render = (
  methods: AuthMethod[],
  over: { oidcName?: string | null; authError?: string | null; localAccounts?: boolean } = {},
) =>
  renderToStaticMarkup(
    <LoginView
      methods={methods}
      oidcName={over.oidcName ?? null}
      localAccounts={over.localAccounts ?? false}
      authError={over.authError ?? null}
      onOidc={() => undefined}
    />,
  );

describe('LoginView', () => {
  it('password only: form, no SSO button', () => {
    const html = render(['password']);
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Sign in with');
    expect(html).not.toContain('login-divider');
  });

  it('local accounts: optional username field above the password', () => {
    const html = render(['password'], { localAccounts: true });
    expect(html.indexOf('autoComplete="username"')).toBeLessThan(html.indexOf('type="password"'));
    expect(html).toContain('Username (optional)');
  });

  it('without local accounts there is no username field', () => {
    expect(render(['password'])).not.toContain('autoComplete="username"');
    expect(render(['oidc', 'header'], { localAccounts: true })).not.toContain('Username');
  });

  it('oidc only: shows the redirect note instead of a form', () => {
    const html = render(['oidc'], { oidcName: 'Authentik' });
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Redirecting to Authentik');
  });

  it('oidc only after an error: button and banner, no auto-redirect view', () => {
    const html = render(['oidc'], { oidcName: 'Authentik', authError: 'oidc_denied' });
    expect(html).toContain('Sign in with Authentik');
    expect(html).toContain('not allowed');
    expect(html).not.toContain('Redirecting');
    expect(html).not.toContain('type="password"');
  });

  it('oidc only right after an auto-redirect: shows the button, not the redirect note', () => {
    const now = 5_000_000;
    const html = renderToStaticMarkup(
      <LoginView
        methods={['oidc']}
        oidcName="Authentik"
        authError={null}
        onOidc={() => undefined}
        lastAutoRedirectAt={now - 5_000}
        now={now}
      />,
    );
    expect(html).toContain('Sign in with Authentik');
    expect(html).not.toContain('Redirecting');
  });

  it('both: form, divider and button; falls back to "SSO" without a name', () => {
    const html = render(['password', 'oidc']);
    expect(html).toContain('type="password"');
    expect(html).toContain('login-divider');
    expect(html).toContain('Sign in with SSO');
  });

  it('shows a generic banner for unknown error codes', () => {
    const html = render(['password', 'oidc'], { authError: 'nope' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Sign-in failed. Please try again.');
  });

  it('header only: proxy message, no form or button', () => {
    const html = render(['header']);
    expect(html).toContain('This server expects sign-in through your authentication proxy.');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
  });
});
