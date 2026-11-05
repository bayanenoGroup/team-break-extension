<?php
// Mirror of extension/lib/models.js (durations only). test/models-parity.mjs
// fails if the two tables ever differ.

final class Models
{
    const MIN_CYCLES = 1;
    const MAX_CYCLES = 8;

    public static function all()
    {
        return [
            'pomodoro' => ['work' => 25, 'shortBreak' => 5, 'longBreak' => 20, 'longEvery' => 4],
            '52-17' => ['work' => 52, 'shortBreak' => 17],
            '90-20' => ['work' => 90, 'shortBreak' => 20],
        ];
    }

    public static function isValid($id)
    {
        return is_string($id) && array_key_exists($id, self::all());
    }

    public static function isValidCycles($n)
    {
        return is_int($n) && $n >= self::MIN_CYCLES && $n <= self::MAX_CYCLES;
    }

    /** @return array<int, array{type:string, duration:int}> durations in ms */
    public static function phases($id, $cycles)
    {
        if (!self::isValid($id) || !self::isValidCycles($cycles)) {
            return [];
        }
        $m = self::all()[$id];
        $out = [];
        for ($c = 1; $c <= $cycles; $c++) {
            $out[] = ['type' => 'work', 'duration' => $m['work'] * 60000];
            $long = isset($m['longEvery']) && $c % $m['longEvery'] === 0;
            $out[] = ['type' => 'break', 'duration' => ($long ? $m['longBreak'] : $m['shortBreak']) * 60000];
        }
        return $out;
    }

    /** 'idle' | 'ready' | 'running' | 'paused' | 'finished' */
    public static function state(array $g, $now)
    {
        if (empty($g['model_id']) || $g['status'] === 'idle') {
            return 'idle';
        }
        if ($g['status'] === 'ready') {
            return 'ready';
        }
        $ref = $g['status'] === 'paused' ? (int) $g['paused_at'] : $now;
        $elapsed = $ref - (int) $g['started_at'] - (int) $g['paused_total'];
        $total = 0;
        foreach (self::phases($g['model_id'], (int) $g['cycles']) as $p) {
            $total += $p['duration'];
        }
        return $elapsed < $total ? $g['status'] : 'finished';
    }
}
