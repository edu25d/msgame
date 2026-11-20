<?php
/**
 * battle-game/rank.php
 * 닷홈 MySQL 기반 도레미 대결 챌린지 실시간 TOP 20 랭킹 API
 *
 * action=list   (GET)  : 상위 20위 랭킹 목록 반환
 * action=submit (POST) : 완주 점수 등록 및 상위 랭킹 유지
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ── DB 설정 파일 로드 ─────────────────────────────────────────
$configPath = dirname(__DIR__) . '/config/db_config.php';
if (!file_exists($configPath)) {
    $configPath = __DIR__ . '/config/db_config.php';
}

if (!file_exists($configPath)) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'message' => 'DB 설정 파일을 찾을 수 없습니다.'], JSON_UNESCAPED_UNICODE);
    exit;
}
require_once $configPath;

function getDB(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . (defined('DB_CHAR') ? DB_CHAR : 'utf8mb4');
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    return $pdo;
}

function jsonOk(array $data): void {
    echo json_encode(array_merge(['ok' => true], $data), JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonErr(string $msg, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'message' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

// ── 테이블 자동 생성 (없을 경우) ──────────────────────────────────
try {
    $db = getDB();
    $db->exec("
        CREATE TABLE IF NOT EXISTS battle_rankings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nickname VARCHAR(30) NOT NULL,
            song_id VARCHAR(50) NOT NULL,
            song_title VARCHAR(100) NOT NULL,
            difficulty VARCHAR(20) DEFAULT '초급',
            difficulty_stars VARCHAR(20) DEFAULT '★☆☆',
            score INT NOT NULL,
            elapsed_sec DECIMAL(6, 2) NOT NULL,
            accuracy INT NOT NULL,
            max_combo INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_score (score DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    ");

    // 기존 테이블에 컬럼 누락 시 자동 보완
    try { $db->exec("ALTER TABLE battle_rankings ADD COLUMN difficulty VARCHAR(20) DEFAULT '초급'"); } catch (Exception $e) {}
    try { $db->exec("ALTER TABLE battle_rankings ADD COLUMN difficulty_stars VARCHAR(20) DEFAULT '★☆☆'"); } catch (Exception $e) {}
} catch (Exception $e) {
    jsonErr('DB 초기화 오류: ' . $e->getMessage(), 500);
}

// GET/POST 요청 본문 및 파라미터 파싱
$action = $_GET['action'] ?? $_POST['action'] ?? '';

$inputJSON = file_get_contents('php://input');
$inputData = [];
if (!empty($inputJSON)) {
    $decoded = json_decode($inputJSON, true);
    if (is_array($decoded)) {
        $inputData = $decoded;
    }
}
if (empty($action) && isset($inputData['action'])) {
    $action = $inputData['action'];
}

// ── 1. 랭킹 목록 조회 (Top 20) ───────────────────────────────────
if ($action === 'list') {
    try {
        $limit = isset($_GET['limit']) ? max(1, min(100, (int)$_GET['limit'])) : 20;
        $stmt = $db->prepare("
            SELECT id, nickname, song_id, song_title, difficulty, difficulty_stars, score, elapsed_sec, accuracy, max_combo, created_at
            FROM battle_rankings
            ORDER BY score DESC, elapsed_sec ASC, created_at ASC
            LIMIT :limit
        ");
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();

        $diffFallbackMap = [
            'scarecrow'   => ['diff' => '초급', 'stars' => '★☆☆'],
            'friend'      => ['diff' => '중급', 'stars' => '★★☆'],
            'town'        => ['diff' => '고급', 'stars' => '★★★'],
            'forest-walk' => ['diff' => '고급', 'stars' => '★★★'],
        ];

        $rankings = [];
        $rank = 1;
        foreach ($rows as $row) {
            $fallback = $diffFallbackMap[$row['song_id']] ?? ['diff' => '초급', 'stars' => '★☆☆'];
            $row['rank'] = $rank++;
            $row['difficulty'] = !empty($row['difficulty']) ? $row['difficulty'] : $fallback['diff'];
            $row['difficulty_stars'] = !empty($row['difficulty_stars']) ? $row['difficulty_stars'] : $fallback['stars'];
            $row['score'] = (int)$row['score'];
            $row['elapsed_sec'] = (float)$row['elapsed_sec'];
            $row['accuracy'] = (int)$row['accuracy'];
            $row['max_combo'] = (int)$row['max_combo'];
            $rankings[] = $row;
        }

        jsonOk(['rankings' => $rankings]);
    } catch (Exception $e) {
        jsonErr('랭킹 조회 실패: ' . $e->getMessage(), 500);
    }
}

// ── 2. 랭킹 점수 등록 (Submit) ─────────────────────────────────────
if ($action === 'submit') {
    $nickname   = trim($inputData['nickname'] ?? $_POST['nickname'] ?? '');
    $songId     = trim($inputData['song_id'] ?? $_POST['song_id'] ?? '');
    $songTitle  = trim($inputData['song_title'] ?? $_POST['song_title'] ?? '');
    $difficulty = trim($inputData['difficulty'] ?? $_POST['difficulty'] ?? '');
    $diffStars  = trim($inputData['difficulty_stars'] ?? $_POST['difficulty_stars'] ?? '');
    $score      = (int)($inputData['score'] ?? $_POST['score'] ?? 0);
    $elapsedSec = (float)($inputData['elapsed_sec'] ?? $_POST['elapsed_sec'] ?? 0);
    $accuracy   = (int)($inputData['accuracy'] ?? $_POST['accuracy'] ?? 0);
    $maxCombo   = (int)($inputData['max_combo'] ?? $_POST['max_combo'] ?? 0);

    if (empty($difficulty)) {
        $diffFallbackMap = [
            'scarecrow'   => ['diff' => '초급', 'stars' => '★☆☆'],
            'friend'      => ['diff' => '중급', 'stars' => '★★☆'],
            'town'        => ['diff' => '고급', 'stars' => '★★★'],
            'forest-walk' => ['diff' => '고급', 'stars' => '★★★'],
        ];
        $fb = $diffFallbackMap[$songId] ?? ['diff' => '초급', 'stars' => '★☆☆'];
        $difficulty = $fb['diff'];
        $diffStars  = $fb['stars'];
    }

    if (mb_strlen($nickname, 'UTF-8') < 1 || mb_strlen($nickname, 'UTF-8') > 20) {
        jsonErr('닉네임은 1~20자 사이여야 합니다.');
    }
    if (empty($songTitle)) {
        jsonErr('곡 정보가 누락되었습니다.');
    }
    if ($score <= 0) {
        jsonErr('점수가 유효하지 않습니다.');
    }

    try {
        $stmt = $db->prepare("
            INSERT INTO battle_rankings 
            (nickname, song_id, song_title, difficulty, difficulty_stars, score, elapsed_sec, accuracy, max_combo)
            VALUES 
            (:nickname, :song_id, :song_title, :difficulty, :difficulty_stars, :score, :elapsed_sec, :accuracy, :max_combo)
        ");
        $stmt->execute([
            ':nickname'        => $nickname,
            ':song_id'         => $songId,
            ':song_title'      => $songTitle,
            ':difficulty'      => $difficulty,
            ':difficulty_stars'=> $diffStars,
            ':score'           => $score,
            ':elapsed_sec'     => $elapsedSec,
            ':accuracy'        => $accuracy,
            ':max_combo'       => $maxCombo
        ]);

        $insertId = (int)$db->lastInsertId();

        // 방금 등록된 점수의 전체 순위 산출
        $rankStmt = $db->prepare("
            SELECT COUNT(*) + 1 AS my_rank
            FROM battle_rankings
            WHERE score > :score OR (score = :score AND elapsed_sec < :elapsed_sec)
        ");
        $rankStmt->execute([':score' => $score, ':elapsed_sec' => $elapsedSec]);
        $myRank = (int)$rankStmt->fetchColumn();

        // 50위 밖의 오래된 데이터 자동 정리
        $db->exec("
            DELETE FROM battle_rankings 
            WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id FROM battle_rankings ORDER BY score DESC, elapsed_sec ASC LIMIT 50
                ) AS top_ranks
            )
        ");

        jsonOk([
            'message' => '등록되었습니다.',
            'id' => $insertId,
            'my_rank' => $myRank
        ]);
    } catch (Exception $e) {
        jsonErr('점수 등록 실패: ' . $e->getMessage(), 500);
    }
}

jsonErr('유효하지 않은 요청입니다.');
