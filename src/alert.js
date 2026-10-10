import { spawn } from 'node:child_process';

function ps(script) {
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
  } catch {}
}

export function beep(times = 3) {
  process.stdout.write('\x07');
  const cmd = Array.from({ length: times }, () => '[console]::beep(1200,350); Start-Sleep -Milliseconds 120').join('; ');
  ps(cmd);
}

export function focusChrome() {
  // Bring the first Chrome window whose title mentions Passo to the front.
  ps(`$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Passo' } | Select-Object -First 1; if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null }`);
}

export function speak(text) {
  ps(`Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`);
}
