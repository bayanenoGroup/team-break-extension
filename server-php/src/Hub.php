<?php
// PHP port of server/src/index.js (Cloudflare). Same routes, same rules,
// same JSON. Compatible with PHP 7.4.

final class HttpError extends Exception
{
    public $status;

    public function __construct($status, $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

final class Hub
{
    const ONLINE_WINDOW = 90000;
    const MAX_MEMBERS = 50;
    const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const CODE_LENGTH = 6;
    const JOIN_FAILS_LIMIT = 10;
    const REGISTER_LIMIT = 30;

    /** @var PDO */
    private $db;
    private $mysql;

    public function __construct(PDO $db)
    {
        $this->db = $db;
        $this->mysql = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
        $this->migrate();
    }

    public static function now()
    {
        return (int) floor(microtime(true) * 1000);
    }

    // ---- routing ----------------------------------------------------------

    /** @return array{0:int, 1:array} */
    public function handle($method, $path, array $body, $authHeader, $ip)
    {
        try {
            $route = $method . ' ' . $path;
            if ($route === 'POST /api/register') {
                return [200, $this->tx(function () use ($body, $ip) {
                    return $this->register($body, $ip);
                })];
            }
            $result = $this->tx(function () use ($route, $body, $authHeader) {
                $user = $this->authenticate($authHeader);
                $now = self::now();
                $this->exec('UPDATE users SET last_seen = ? WHERE id = ?', [$now, $user['id']]);

                switch ($route) {
                    case 'GET /api/state':
                        break;
                    case 'POST /api/me/name':
                        $this->rename($user, $body);
                        break;
                    case 'POST /api/groups/create':
                        $this->createGroup($user, $body, $now);
                        break;
                    case 'POST /api/groups/join':
                        $this->joinGroup($user, $body, $now);
                        break;
                    case 'POST /api/groups/leave':
                        $this->leaveGroup($user);
                        break;
                    case 'POST /api/groups/delete':
                        $this->deleteGroup($this->ownedGroup($user));
                        break;
                    case 'POST /api/groups/kick':
                        $this->kick($this->ownedGroup($user), $body);
                        break;
                    case 'POST /api/groups/regenerate-code':
                        $this->regenerateCode($this->ownedGroup($user));
                        break;
                    case 'POST /api/groups/select-model':
                        $this->selectModel($this->ownedGroup($user), $body, $now);
                        break;
                    case 'POST /api/groups/start':
                        $this->start($this->ownedGroup($user), $now);
                        break;
                    case 'POST /api/groups/pause':
                        $this->pause($this->ownedGroup($user), $now);
                        break;
                    case 'POST /api/groups/resume':
                        $this->resume($this->ownedGroup($user), $now);
                        break;
                    case 'POST /api/groups/stop':
                        $this->stop($this->ownedGroup($user));
                        break;
                    default:
                        throw new HttpError(404, 'not_found');
                }
                return $this->stateFor($user['id'], self::now());
            });
            return [200, $result];
        } catch (HttpError $e) {
            return [$e->status, ['error' => $e->getMessage()]];
        }
    }

    /**
     * Runs a request in one transaction. Failed join/register attempts are
     * recorded even when the request itself fails, so they commit separately.
     */
    private function tx(callable $fn)
    {
        $this->pendingAttempts = [];
        $this->db->beginTransaction();
        try {
            $result = $fn();
            $this->db->commit();
            return $result;
        } catch (Exception $e) {
            $this->db->rollBack();
            if ($this->pendingAttempts) {
                foreach ($this->pendingAttempts as $a) {
                    $this->exec('INSERT INTO attempts (kind, akey, at) VALUES (?, ?, ?)', $a);
                }
            }
            throw $e;
        }
    }

    private $pendingAttempts = [];

    // ---- identity ---------------------------------------------------------

    private function register(array $body, $ip)
    {
        $name = self::cleanName(isset($body['name']) ? $body['name'] : '');
        $now = self::now();
        $this->throttle('register', $ip, self::REGISTER_LIMIT, 3600000, $now,
            'تعداد ثبت‌نام از این شبکه زیاد است؛ کمی بعد دوباره امتحان کن.');
        $this->exec('INSERT INTO attempts (kind, akey, at) VALUES (?, ?, ?)', ['register', $ip, $now]);

        $id = self::uuid();
        $token = self::base64url(random_bytes(32));
        $this->exec(
            'INSERT INTO users (id, token_hash, name, group_id, last_seen, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
            [$id, hash('sha256', $token), $name, $now, $now]
        );
        return array_merge(['userId' => $id, 'token' => $token], $this->stateFor($id, $now));
    }

    private function authenticate($header)
    {
        $token = strpos((string) $header, 'Bearer ') === 0 ? substr($header, 7) : '';
        if ($token === '') {
            throw new HttpError(401, 'unauthorized');
        }
        $lock = $this->mysql ? ' FOR UPDATE' : '';
        $user = $this->row('SELECT * FROM users WHERE token_hash = ?' . $lock, [hash('sha256', $token)]);
        if (!$user) {
            throw new HttpError(401, 'unauthorized');
        }
        return $user;
    }

    private function rename(array $user, array $body)
    {
        $name = self::cleanName(isset($body['name']) ? $body['name'] : '');
        $this->exec('UPDATE users SET name = ? WHERE id = ?', [$name, $user['id']]);
        if ($user['group_id']) {
            $this->bump($user['group_id']);
        }
    }

    // ---- groups -----------------------------------------------------------

    private function createGroup(array $user, array $body, $now)
    {
        if ($user['group_id']) {
            throw new HttpError(409, 'تو الان عضو یک گروه هستی. اول از آن خارج شو.');
        }
        $name = self::cleanName(isset($body['name']) ? $body['name'] : '', 'نام گروه');
        $id = self::uuid();
        $this->exec(
            "INSERT INTO groups_ (id, name, code, owner_id, status, paused_total, version, created_at)
             VALUES (?, ?, ?, ?, 'idle', 0, 1, ?)",
            [$id, $name, $this->uniqueCode(), $user['id'], $now]
        );
        $this->exec('UPDATE users SET group_id = ? WHERE id = ?', [$id, $user['id']]);
    }

    private function joinGroup(array $user, array $body, $now)
    {
        if ($user['group_id']) {
            throw new HttpError(409, 'تو الان عضو یک گروه هستی. اول از آن خارج شو.');
        }
        $this->throttle('join', $user['id'], self::JOIN_FAILS_LIMIT, 600000, $now,
            'تلاش ناموفق زیاد بود؛ ۱۰ دقیقه‌ی دیگر دوباره امتحان کن.');
        $code = preg_replace('/[\s-]/', '', strtoupper(trim((string) (isset($body['code']) ? $body['code'] : ''))));
        $group = $this->row('SELECT * FROM groups_ WHERE code = ?', [$code]);
        if (!$group) {
            $this->pendingAttempts[] = ['join', $user['id'], $now];
            throw new HttpError(404, 'گروهی با این کد پیدا نشد.');
        }
        $count = (int) $this->value('SELECT COUNT(*) FROM users WHERE group_id = ?', [$group['id']]);
        if ($count >= self::MAX_MEMBERS) {
            throw new HttpError(409, 'ظرفیت این گروه پر است.');
        }
        $this->exec('UPDATE users SET group_id = ? WHERE id = ?', [$group['id'], $user['id']]);
        $this->bump($group['id']);
    }

    private function leaveGroup(array $user)
    {
        if (!$user['group_id']) {
            throw new HttpError(409, 'عضو هیچ گروهی نیستی.');
        }
        $group = $this->groupById($user['group_id']);
        if ($group && $group['owner_id'] === $user['id']) {
            throw new HttpError(409, 'سازنده‌ی گروه نمی‌تواند خارج شود؛ می‌تواند گروه را حذف کند.');
        }
        $this->exec('UPDATE users SET group_id = NULL WHERE id = ?', [$user['id']]);
        if ($group) {
            $this->bump($group['id']);
        }
    }

    private function deleteGroup(array $group)
    {
        $this->exec('UPDATE users SET group_id = NULL WHERE group_id = ?', [$group['id']]);
        $this->exec('DELETE FROM groups_ WHERE id = ?', [$group['id']]);
    }

    private function kick(array $group, array $body)
    {
        $target = (string) (isset($body['userId']) ? $body['userId'] : '');
        if ($target === $group['owner_id']) {
            throw new HttpError(400, 'سازنده را نمی‌شود حذف کرد.');
        }
        $n = $this->exec('UPDATE users SET group_id = NULL WHERE id = ? AND group_id = ?', [$target, $group['id']]);
        if (!$n) {
            throw new HttpError(404, 'این عضو در گروه نیست.');
        }
        $this->bump($group['id']);
    }

    private function regenerateCode(array $group)
    {
        $this->exec('UPDATE groups_ SET code = ? WHERE id = ?', [$this->uniqueCode(), $group['id']]);
        $this->bump($group['id']);
    }

    // ---- schedule ---------------------------------------------------------

    private function selectModel(array $group, array $body, $now)
    {
        $state = Models::state($group, $now);
        if ($state === 'running' || $state === 'paused') {
            throw new HttpError(409, 'اول تایمر فعلی را متوقف کن.');
        }
        $modelId = (string) (isset($body['modelId']) ? $body['modelId'] : '');
        $cycles = isset($body['cycles']) && is_int($body['cycles']) ? $body['cycles'] : null;
        if (!Models::isValid($modelId)) {
            throw new HttpError(400, 'مدل نامعتبر است.');
        }
        if (!Models::isValidCycles($cycles)) {
            throw new HttpError(400, 'تعداد حلقه باید بین ۱ تا ۸ باشد.');
        }
        // Durations are never accepted from the client: only the model id.
        $this->exec(
            "UPDATE groups_ SET model_id = ?, cycles = ?, status = 'ready',
             started_at = NULL, paused_at = NULL, paused_total = 0 WHERE id = ?",
            [$modelId, $cycles, $group['id']]
        );
        $this->bump($group['id']);
    }

    private function start(array $group, $now)
    {
        $state = Models::state($group, $now);
        if ($state !== 'ready' && $state !== 'finished') {
            throw new HttpError(409, $state === 'idle' ? 'اول یک مدل انتخاب کن.' : 'تایمر در حال اجراست.');
        }
        $this->exec(
            "UPDATE groups_ SET status = 'running', started_at = ?, paused_at = NULL, paused_total = 0 WHERE id = ?",
            [$now, $group['id']]
        );
        $this->bump($group['id']);
    }

    private function pause(array $group, $now)
    {
        if (Models::state($group, $now) !== 'running') {
            throw new HttpError(409, 'تایمر در حال اجرا نیست.');
        }
        $this->exec("UPDATE groups_ SET status = 'paused', paused_at = ? WHERE id = ?", [$now, $group['id']]);
        $this->bump($group['id']);
    }

    private function resume(array $group, $now)
    {
        if ($group['status'] !== 'paused') {
            throw new HttpError(409, 'تایمر متوقف موقت نیست.');
        }
        $this->exec(
            "UPDATE groups_ SET status = 'running', paused_total = paused_total + ?, paused_at = NULL WHERE id = ?",
            [$now - (int) $group['paused_at'], $group['id']]
        );
        $this->bump($group['id']);
    }

    private function stop(array $group)
    {
        if (!$group['model_id']) {
            throw new HttpError(409, 'تایمری برای توقف نیست.');
        }
        $this->exec(
            "UPDATE groups_ SET status = 'ready', started_at = NULL, paused_at = NULL, paused_total = 0 WHERE id = ?",
            [$group['id']]
        );
        $this->bump($group['id']);
    }

    // ---- view -------------------------------------------------------------

    private function stateFor($userId, $now)
    {
        $user = $this->row('SELECT * FROM users WHERE id = ?', [$userId]);
        $base = ['serverTime' => $now, 'user' => ['id' => $user['id'], 'name' => $user['name']], 'group' => null];
        if (!$user['group_id']) {
            return $base;
        }
        $g = $this->groupById($user['group_id']);
        if (!$g) {
            return $base;
        }
        $isOwner = $g['owner_id'] === $user['id'];
        $members = [];
        foreach ($this->rows('SELECT id, name, last_seen FROM users WHERE group_id = ? ORDER BY created_at, id', [$g['id']]) as $m) {
            $members[] = [
                'id' => $m['id'],
                'name' => $m['name'],
                'isOwner' => $m['id'] === $g['owner_id'],
                'online' => $now - (int) $m['last_seen'] < self::ONLINE_WINDOW,
            ];
        }
        $base['group'] = [
            'id' => $g['id'],
            'name' => $g['name'],
            'isOwner' => $isOwner,
            'code' => $isOwner ? $g['code'] : null,
            'members' => $members,
            'version' => (int) $g['version'],
            'schedule' => [
                'modelId' => $g['model_id'],
                'cycles' => $g['cycles'] === null ? null : (int) $g['cycles'],
                'status' => $g['status'],
                'startedAt' => $g['started_at'] === null ? null : (int) $g['started_at'],
                'pausedAt' => $g['paused_at'] === null ? null : (int) $g['paused_at'],
                'pausedTotal' => (int) $g['paused_total'],
            ],
        ];
        return $base;
    }

    // ---- helpers ----------------------------------------------------------

    private function ownedGroup(array $user)
    {
        $group = $user['group_id'] ? $this->groupById($user['group_id']) : null;
        if (!$group) {
            throw new HttpError(409, 'عضو هیچ گروهی نیستی.');
        }
        if ($group['owner_id'] !== $user['id']) {
            throw new HttpError(403, 'فقط سازنده‌ی گروه این کار را می‌تواند بکند.');
        }
        return $group;
    }

    private function groupById($id)
    {
        $lock = $this->mysql ? ' FOR UPDATE' : '';
        return $this->row('SELECT * FROM groups_ WHERE id = ?' . $lock, [$id]);
    }

    private function bump($groupId)
    {
        $this->exec('UPDATE groups_ SET version = version + 1 WHERE id = ?', [$groupId]);
    }

    private function uniqueCode()
    {
        $alpha = self::CODE_ALPHABET;
        for ($i = 0; $i < 20; $i++) {
            $code = '';
            foreach (str_split(random_bytes(self::CODE_LENGTH)) as $b) {
                $code .= $alpha[ord($b) % strlen($alpha)];
            }
            if (!$this->value('SELECT 1 FROM groups_ WHERE code = ?', [$code])) {
                return $code;
            }
        }
        throw new HttpError(500, 'ساخت کد ممکن نشد؛ دوباره امتحان کن.');
    }

    private function throttle($kind, $key, $limit, $windowMs, $now, $message)
    {
        $this->exec('DELETE FROM attempts WHERE at < ?', [$now - 3600000]);
        $n = (int) $this->value(
            'SELECT COUNT(*) FROM attempts WHERE kind = ? AND akey = ? AND at > ?',
            [$kind, $key, $now - $windowMs]
        );
        if ($n >= $limit) {
            throw new HttpError(429, $message);
        }
    }

    private static function cleanName($value, $label = 'نام')
    {
        $name = preg_replace('/[\x00-\x1f\x7f<>]/u', '', (string) $value);
        $name = trim(preg_replace('/\s+/u', ' ', $name));
        if ($name === '') {
            throw new HttpError(400, $label . ' را وارد کن.');
        }
        if (mb_strlen($name, 'UTF-8') > 40) {
            throw new HttpError(400, $label . ' حداکثر ۴۰ نویسه است.');
        }
        return $name;
    }

    private static function uuid()
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }

    private static function base64url($bytes)
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private function exec($sql, array $params = [])
    {
        $st = $this->db->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    private function row($sql, array $params = [])
    {
        $st = $this->db->prepare($sql);
        $st->execute($params);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r ?: null;
    }

    private function rows($sql, array $params = [])
    {
        $st = $this->db->prepare($sql);
        $st->execute($params);
        return $st->fetchAll(PDO::FETCH_ASSOC);
    }

    private function value($sql, array $params = [])
    {
        $st = $this->db->prepare($sql);
        $st->execute($params);
        return $st->fetchColumn();
    }

    // `groups` is a reserved word in MySQL 8, hence `groups_`.
    private function migrate()
    {
        if ($this->mysql) {
            $engine = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
            $this->db->exec("CREATE TABLE IF NOT EXISTS users (
                id CHAR(36) PRIMARY KEY,
                token_hash CHAR(64) NOT NULL UNIQUE,
                name VARCHAR(160) NOT NULL,
                group_id CHAR(36) NULL,
                last_seen BIGINT NOT NULL,
                created_at BIGINT NOT NULL,
                KEY users_group (group_id)
            )" . $engine);
            $this->db->exec("CREATE TABLE IF NOT EXISTS groups_ (
                id CHAR(36) PRIMARY KEY,
                name VARCHAR(160) NOT NULL,
                code CHAR(6) NOT NULL UNIQUE,
                owner_id CHAR(36) NOT NULL,
                model_id VARCHAR(16) NULL,
                cycles TINYINT NULL,
                status VARCHAR(10) NOT NULL,
                started_at BIGINT NULL,
                paused_at BIGINT NULL,
                paused_total BIGINT NOT NULL DEFAULT 0,
                version INT NOT NULL DEFAULT 1,
                created_at BIGINT NOT NULL
            )" . $engine);
            $this->db->exec("CREATE TABLE IF NOT EXISTS attempts (
                kind VARCHAR(10) NOT NULL,
                akey VARCHAR(64) NOT NULL,
                at BIGINT NOT NULL,
                KEY attempts_key (kind, akey, at)
            )" . $engine);
            return;
        }
        $this->db->exec("
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                group_id TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS users_group ON users(group_id);
            CREATE TABLE IF NOT EXISTS groups_ (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
                owner_id TEXT NOT NULL, model_id TEXT, cycles INTEGER, status TEXT NOT NULL,
                started_at INTEGER, paused_at INTEGER, paused_total INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts (kind TEXT NOT NULL, akey TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS attempts_key ON attempts(kind, akey, at);
        ");
    }
}
