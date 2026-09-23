# Export the deliverables in final/ to PDF.
#
#     powershell -ExecutionPolicy Bypass -File submission/sih/topdf.ps1
#
# Office rather than LibreOffice, because Office is what is installed and it is the
# renderer the portal's reviewers will open the source files in anyway. Run this after
# build.py; a PDF is stale the moment its source is rebuilt.
#
# New-Object -ComObject attaches to an already-running Office instance rather than
# starting a fresh one, so quitting unconditionally would close the documents you have
# open. The function below quits only the instance it started.

$final = Join-Path $PSScriptRoot 'final'

function Export-Deck($name) {
    $src = Join-Path $final "$name.pptx"
    if (-not (Test-Path $src)) { Write-Host "skip $name.pptx (not built)"; return }
    $wasRunning = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
    $app = New-Object -ComObject PowerPoint.Application
    try {
        $doc = $app.Presentations.Open($src, $true, $false, $false)   # readonly, untitled, no window
        $doc.SaveAs((Join-Path $final "$name.pdf"), 32)               # 32 = ppSaveAsPDF
        $doc.Close()
        Write-Host "wrote final/$name.pdf"
    } finally { if (-not $wasRunning) { $app.Quit() } }
}

Export-Deck 'VVater-SIH2026'
