import type { MailMessage } from '../../infrastructure/mailer.ts';

/**
 * Email templates. Links put the token in the URL fragment (#token=...),
 * not the query string: fragments are never sent to servers, so the token
 * does not end up in web server logs, proxy logs or Referer headers.
 */
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

function render(
  to: string,
  subject: string,
  name: string,
  paragraphs: string[],
  link?: { url: string; label: string },
): MailMessage {
  const text = [
    `Hi ${name},`,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(link ? [link.url, ''] : []),
    'StreamHub',
  ].join('\n');
  const html = [
    `<p>Hi ${escapeHtml(name)},</p>`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(link ? [`<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`] : []),
    '<p>StreamHub</p>',
  ].join('\n');
  return { to, subject, text, html };
}

export function verificationEmail(
  to: string,
  name: string,
  webOrigin: string,
  token: string,
  ttlHours: number,
): MailMessage {
  return render(
    to,
    'Verify your StreamHub email address',
    name,
    [
      `Please confirm your email address to finish creating your account. The link expires in ${ttlHours} hours.`,
    ],
    { url: `${webOrigin}/verify-email#token=${token}`, label: 'Verify my email address' },
  );
}

export function alreadyRegisteredEmail(to: string, name: string, webOrigin: string): MailMessage {
  return render(
    to,
    'Someone tried to register with your email',
    name,
    [
      'Someone (perhaps you) tried to create a new StreamHub account with this email address, but you already have an account.',
      'If it was you, sign in or reset your password. If not, you can ignore this email; nothing has changed.',
    ],
    { url: `${webOrigin}/login`, label: 'Sign in' },
  );
}

export function passwordResetEmail(
  to: string,
  name: string,
  webOrigin: string,
  token: string,
  ttlMinutes: number,
): MailMessage {
  return render(
    to,
    'Reset your StreamHub password',
    name,
    [
      `Use the link below to choose a new password. It works once and expires in ${ttlMinutes} minutes.`,
      'If you did not ask for this, ignore this email; your password has not changed.',
    ],
    { url: `${webOrigin}/reset-password#token=${token}`, label: 'Choose a new password' },
  );
}

export function passwordChangedEmail(to: string, name: string): MailMessage {
  return render(to, 'Your StreamHub password was changed', name, [
    'Your password was just changed and all other sessions were signed out.',
    'If this was not you, reset your password immediately and contact support.',
  ]);
}

export function accountDeactivatedEmail(to: string, name: string): MailMessage {
  return render(to, 'Your StreamHub account was deactivated', name, [
    'Your account has been deactivated and all sessions were signed out.',
    'If this was not you, contact support.',
  ]);
}

export function mfaEnabledEmail(to: string, name: string): MailMessage {
  return render(to, 'Two-factor authentication is on', name, [
    'Two-factor authentication was turned on for your account. Signing in now also needs a code from your authenticator app.',
    'Keep your recovery codes somewhere safe. If this was not you, contact support immediately.',
  ]);
}

export function mfaDisabledEmail(to: string, name: string): MailMessage {
  return render(to, 'Two-factor authentication was turned off', name, [
    'Two-factor authentication was turned off for your account.',
    'If this was not you, change your password and contact support immediately.',
  ]);
}

export function recoveryCodeUsedEmail(to: string, name: string, remaining: number): MailMessage {
  return render(to, 'A recovery code was used to sign in', name, [
    `A recovery code was just used to sign in to your account. You have ${remaining} unused recovery codes left.`,
    'If this was not you, change your password and contact support immediately.',
  ]);
}

export function recoveryCodesRegeneratedEmail(to: string, name: string): MailMessage {
  return render(to, 'New recovery codes were created', name, [
    'New two-factor recovery codes were created for your account. The old ones no longer work.',
    'If this was not you, change your password and contact support immediately.',
  ]);
}
