<?php
// Front controller. nginx sends every request for nafas.bayaneno.com here.
// Config comes from ../.env (outside the web root, never in git).

declare(strict_types=0);
error_reporting(E_ALL);
ini_set('display_errors', '0');

require __DIR__ . '/../src/Models.php';
require __DIR__ . '/../src/Hub.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Max-Age: 86400');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond($status, $body)
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function load_env($file)
{
    $env = [];
    if (!is_readable($file)) {
        return $env;
    }
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) {
            continue;
        }
        list($k, $v) = explode('=', $line, 2);
        $env[trim($k)] = trim(trim($v), "\"'");
    }
    return $env;
}

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
$path = parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($path === '/' || $path === '/health') {
    respond(200, ['ok' => true, 'service' => 'nafas-team-break']);
}
if (strpos($path, '/api/') !== 0) {
    respond(404, ['error' => 'not_found']);
}

$env = load_env(getenv('NAFAS_ENV_FILE') ?: __DIR__ . '/../.env');

try {
    if (!empty($env['DB_DSN'])) {
        $db = new PDO($env['DB_DSN'], isset($env['DB_USER']) ? $env['DB_USER'] : null,
            isset($env['DB_PASS']) ? $env['DB_PASS'] : null);
    } else {
        respond(500, ['error' => 'سرور پیکربندی نشده است.']);
    }
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql') {
        $db->exec("SET NAMES utf8mb4");
    } else {
        $db->exec('PRAGMA busy_timeout = 5000');
    }

    $raw = $method === 'POST' ? file_get_contents('php://input') : '';
    $body = $raw !== '' ? json_decode($raw, true) : [];
    if (!is_array($body)) {
        $body = [];
    }
    $auth = isset($_SERVER['HTTP_AUTHORIZATION']) ? $_SERVER['HTTP_AUTHORIZATION']
        : (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION']) ? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] : '');
    // Behind ArvanCloud the visitor IP arrives in a header; only used for rate limiting.
    $ip = isset($_SERVER['HTTP_AR_REAL_IP']) ? $_SERVER['HTTP_AR_REAL_IP']
        : (isset($_SERVER['HTTP_X_REAL_IP']) ? $_SERVER['HTTP_X_REAL_IP']
        : (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown'));
    $ip = substr((string) $ip, 0, 64);

    $hub = new Hub($db);
    list($status, $result) = $hub->handle($method, $path, $body, $auth, $ip);
    respond($status, $result);
} catch (Throwable $e) {
    error_log('[nafas] ' . $e->getMessage());
    respond(500, ['error' => 'خطای داخلی سرور']);
}
