<#
.SYNOPSIS
    Generates PNG icon files for the Stream Video Downloader Chrome extension.
.DESCRIPTION
    Creates icon16.png, icon32.png, icon48.png, and icon128.png with a green
    download arrow on a dark rounded rectangle background with a small play triangle.
#>

Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sizes = @(16, 32, 48, 128)

$bgColor = [System.Drawing.Color]::FromArgb(255, 26, 26, 46)       # #1a1a2e
$greenColor = [System.Drawing.Color]::FromArgb(255, 76, 175, 80)   # #4CAF50
$greenLight = [System.Drawing.Color]::FromArgb(255, 102, 187, 106) # #66BB6A
$greenDark = [System.Drawing.Color]::FromArgb(255, 56, 142, 60)    # #388E3C
$transparent = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)

function New-RoundedRectPath {
    param([float]$x, [float]$y, [float]$w, [float]$h, [float]$r)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

foreach ($size in $sizes) {
    $s = [float]$size
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear($transparent)

    # --- Rounded rectangle background ---
    $cornerRadius = $s * 0.18
    $bgPath = New-RoundedRectPath -x 0 -y 0 -w $s -h $s -r $cornerRadius

    if ($size -ge 48) {
        $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.PointF(0, 0)),
            (New-Object System.Drawing.PointF(0, $s)),
            [System.Drawing.Color]::FromArgb(255, 34, 34, 58),
            [System.Drawing.Color]::FromArgb(255, 18, 18, 31)
        )
        $g.FillPath($bgBrush, $bgPath)
        $bgBrush.Dispose()
    } else {
        $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
        $g.FillPath($bgBrush, $bgPath)
        $bgBrush.Dispose()
    }

    # --- Download arrow (stem + chevron as single polygon) ---
    $cx = $s / 2
    $stemW = $s * 0.14
    $arrowW = $s * 0.32
    $arrowTop = $s * 0.18
    $arrowMid = $s * 0.48
    $arrowBot = $s * 0.66

    $arrowPoints = @(
        (New-Object System.Drawing.PointF(($cx - $stemW / 2), $arrowTop)),
        (New-Object System.Drawing.PointF(($cx + $stemW / 2), $arrowTop)),
        (New-Object System.Drawing.PointF(($cx + $stemW / 2), $arrowMid)),
        (New-Object System.Drawing.PointF(($cx + $arrowW),    $arrowMid)),
        (New-Object System.Drawing.PointF($cx,                $arrowBot)),
        (New-Object System.Drawing.PointF(($cx - $arrowW),    $arrowMid)),
        (New-Object System.Drawing.PointF(($cx - $stemW / 2), $arrowMid))
    )

    if ($size -ge 128) {
        $arrowBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.PointF(0, $arrowTop)),
            (New-Object System.Drawing.PointF(0, $arrowBot)),
            $greenLight,
            $greenColor
        )
    } else {
        $arrowBrush = New-Object System.Drawing.SolidBrush($greenColor)
    }
    $g.FillPolygon($arrowBrush, $arrowPoints)
    $arrowBrush.Dispose()

    # --- Small play triangle inside the arrow stem ---
    $playSize = $s * 0.08
    $playCx = $cx
    $playCy = $arrowTop + ($arrowMid - $arrowTop) * 0.45

    $playPoints = @(
        (New-Object System.Drawing.PointF(($playCx - $playSize * 0.4), ($playCy - $playSize * 0.55))),
        (New-Object System.Drawing.PointF(($playCx - $playSize * 0.4), ($playCy + $playSize * 0.55))),
        (New-Object System.Drawing.PointF(($playCx + $playSize * 0.6), $playCy))
    )
    $playBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $g.FillPolygon($playBrush, $playPoints)
    $playBrush.Dispose()

    # --- U-shaped tray ---
    $trayY = $s * 0.78
    $trayW = $s * 0.52
    $trayThick = [Math]::Max(1.5, $s * 0.045)
    $trayCorner = $s * 0.04
    $trayDepth = $s * 0.08

    $trayPen = New-Object System.Drawing.Pen($greenColor, $trayThick)
    $trayPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $trayPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $trayPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $trayPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $trayLeft = $cx - $trayW / 2
    $trayRight = $cx + $trayW / 2
    $trayBottom = $trayY + $trayDepth

    $trayPath.AddLine($trayLeft, $trayY, $trayLeft, ($trayBottom - $trayCorner))
    $trayPath.AddArc($trayLeft, ($trayBottom - $trayCorner * 2), ($trayCorner * 2), ($trayCorner * 2), 180, -90)
    $trayPath.AddLine(($trayLeft + $trayCorner), $trayBottom, ($trayRight - $trayCorner), $trayBottom)
    $trayPath.AddArc(($trayRight - $trayCorner * 2), ($trayBottom - $trayCorner * 2), ($trayCorner * 2), ($trayCorner * 2), 90, -90)
    $trayPath.AddLine($trayRight, ($trayBottom - $trayCorner), $trayRight, $trayY)

    $g.DrawPath($trayPen, $trayPath)
    $trayPen.Dispose()
    $trayPath.Dispose()

    # --- Drop shadow for 128px icon ---
    if ($size -ge 128) {
        # Draw a subtle glow under the arrow by re-drawing with transparency offset
        # (already handled by the gradient, keeping it clean)
    }

    # --- Save ---
    $outPath = Join-Path $scriptDir "icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Created $outPath ($size x $size)"

    # Cleanup
    $bgPath.Dispose()
    $g.Dispose()
    $bmp.Dispose()
}

Write-Host "`nAll icons generated successfully!" -ForegroundColor Green
