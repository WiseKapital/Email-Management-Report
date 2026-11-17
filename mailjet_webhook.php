<?php
$ARCHIVO_LOG = __DIR__ . '/clics_log.php';
header('Content-Type: application/json; charset=utf-8');

// 1) Cuando Mailjet manda un clic (POST): lo guarda
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data)) {
        echo json_encode(['ok' => true, 'guardados' => 0]);
        exit;
    }

    $eventos = isset($data['event']) ? [$data] : $data;
    $cuenta  = preg_replace('/[^A-Za-z0-9_-]/', '', $_GET['cuenta'] ?? 'MLJ1');
    if ($cuenta === 'MLJSH' || $cuenta === 'MLJ3') {
        $cuenta = 'MLJ_SH';
    }

    if (!file_exists($ARCHIVO_LOG)) {
        file_put_contents($ARCHIVO_LOG, "<?php exit; ?>\n", LOCK_EX);
    }

    $lineas = '';
    $guardados = 0;
    foreach ($eventos as $ev) {
        if (!is_array($ev) || strtolower($ev['event'] ?? '') !== 'click') continue;
        $ts = isset($ev['time']) ? (int)$ev['time'] : time();
        $lineas .= json_encode([
            'fecha'       => gmdate('Y-m-d', $ts - 5 * 3600),
            'cuenta'      => $cuenta,
            'ip'          => $ev['ip'] ?? '',
            'campaign_id' => (int)($ev['mj_campaign_id'] ?? 0),
            'time'        => $ts
        ]) . "\n";
        $guardados++;
    }

    if ($lineas !== '') {
        file_put_contents($ARCHIVO_LOG, $lineas, FILE_APPEND | LOCK_EX);
    }

    echo json_encode(['ok' => true, 'guardados' => $guardados]);
    exit;
}

// 2) Cuando GitHub ya guardó el CSV (?borrar=YYYY-MM-DD): limpia hasta esa fecha
if (isset($_GET['borrar']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $_GET['borrar'])) {
    $borrarHasta = $_GET['borrar'];
    $borrados = 0;
    $restantes = 0;

    if (file_exists($ARCHIVO_LOG)) {
        $fp = fopen($ARCHIVO_LOG, 'c+');
        if ($fp && flock($fp, LOCK_EX)) {
            $contenido = stream_get_contents($fp);
            $nuevasLineas = ["<?php exit; ?>"];
            foreach (explode("\n", $contenido) as $linea) {
                $linea = trim($linea);
                if ($linea === '' || strpos($linea, '<?php') === 0) continue;
                $item = json_decode($linea, true);
                if (!is_array($item)) continue;
                if (($item['fecha'] ?? '') <= $borrarHasta) {
                    $borrados++;
                } else {
                    $nuevasLineas[] = $linea;
                    $restantes++;
                }
            }
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, implode("\n", $nuevasLineas) . "\n");
            fflush($fp);
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }

    echo json_encode([
        'ok'        => true,
        'hasta'     => $borrarHasta,
        'borrados'  => $borrados,
        'restantes' => $restantes
    ]);
    exit;
}

// 3) Cuando entras tú o GitHub a leer (GET): muestra los clics
$fechaFiltro = $_GET['fecha'] ?? '';
$resultado = [];

if (file_exists($ARCHIVO_LOG)) {
    foreach (file($ARCHIVO_LOG, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $linea) {
        if (strpos($linea, '<?php') === 0) continue;
        $item = json_decode($linea, true);
        if (!is_array($item)) continue;
        if ($fechaFiltro === '' || ($item['fecha'] ?? '') === $fechaFiltro) {
            $resultado[] = $item;
        }
    }
}

echo json_encode([
    'total' => count($resultado),
    'clics' => $resultado
]);