// Desktop (toast) notifications for Windows, using the built-in
// Windows.UI.Notifications API through PowerShell. No installs required.
// Silently no-ops on non-Windows or if the toast API is unavailable.

import { spawn } from 'node:child_process';

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function notify(title, message) {
  if (process.platform !== 'win32') return;

  const script = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName('text')
  $texts.Item(0).AppendChild($template.CreateTextNode('${esc(title)}')) | Out-Null
  $texts.Item(1).AppendChild($template.CreateTextNode('${esc(message)}')) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Site Monitor')
  $notifier.Show($toast)
} catch {
  # Fallback: balloon tip via Windows Forms.
  Add-Type -AssemblyName System.Windows.Forms
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.BalloonTipTitle = '${esc(title)}'
  $n.BalloonTipText = '${esc(message)}'
  $n.Visible = $true
  $n.ShowBalloonTip(8000)
  Start-Sleep -Seconds 9
  $n.Dispose()
}
`;

  try {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore', detached: true, windowsHide: true,
    });
    ps.on('error', () => {});
    ps.unref();
  } catch {
    // ignore — notifications are best-effort
  }
}
