# Export the deliverables in final/ to PDF.
#
#     powershell -ExecutionPolicy Bypass -File submission/sih/topdf.ps1
#
# Office rather than LibreOffice, because Office is what is installed and it is the
# renderer the portal's reviewers will open the source files in anyway. Run this after
# build.py / proposal.py; a PDF is stale the moment its source is rebuilt.
#
# New-Object -ComObject attaches to an already-running Office instance rather than
# starting a fresh one, so quitting unconditionally would close the documents you have
# open. Both functions below quit only the instance they started.

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

function Export-Doc($name) {
    $src = Join-Path $final "$name.docx"
    if (-not (Test-Path $src)) { Write-Host "skip $name.docx (not built)"; return }
    $wasRunning = [bool](Get-Process WINWORD -ErrorAction SilentlyContinue)
    $app = New-Object -ComObject Word.Application
    if (-not $wasRunning) { $app.Visible = $false }
    try {
        $doc = $app.Documents.Open($src, $false, $true)               # no confirm, readonly
        $doc.SaveAs([ref](Join-Path $final "$name.pdf"), [ref]17)     # 17 = wdFormatPDF
        $doc.Close($false)
        Write-Host "wrote final/$name.pdf"
    } finally { if (-not $wasRunning) { $app.Quit() } }
}

Export-Deck 'VVater-SIH2026'
Export-Doc  'VVater-SIH2026-proposal'
