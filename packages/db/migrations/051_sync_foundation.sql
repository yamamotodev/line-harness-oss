-- Migration 051: 同期基盤（sync_scopes / gate / reconciliation / 設備）
--
-- 【この形にした理由】
-- 現在の外部同期には、二重予約に直結する穴が3つある。
--   ① 管理画面から入れた予約が外部に出ていかない
--      （同期ジョブが status='requested' しか見ないイベント駆動。管理画面は
--        'confirmed' で直接作るのでイベントが発生しない）
--   ② 新媒体・新店舗を足すと、台帳が空のまま同期対象になる（初期同期が無い）
--   ③ 止まっても誰も気づかない（実測でジョブBが9日14時間停止し未検知）
-- ①②は同じ1つの修正で閉じる＝「イベントを拾う」から「状態を突き合わせる
-- (reconciliation)」への変更。そのために「同期の単位(scope)」と「その単位が今
-- 販売してよい状態か」をDBに持つ。③は fresh_until を過ぎたら gate が自動的に
-- 販売を閉じることで、人の注意力に依存せず閉じる。
--
-- 【方針】additive-only (CONTRIBUTING.md §Migration Policy / scripts/check-migrations.ts)
--   OK: CREATE TABLE / CREATE [UNIQUE] INDEX / CREATE VIEW / INSERT / UPDATE /
--       ALTER TABLE ... ADD COLUMN (NULL または DEFAULT 付き)
--   NG: DROP TABLE / DROP COLUMN / RENAME COLUMN / ALTER COLUMN TYPE /
--       RENAME TABLE / ADD COLUMN NOT NULL (DEFAULT 無し) / ADD UNIQUE /
--       ADD CONSTRAINT ... UNIQUE
--
-- 【語の約束】
--   is_active  … 人が決める「使う意思」
--   readiness  … 機械が決める「実際に使えるか」
--   この2つは別概念なので分ける。'active' という状態名は is_active と紛らわしい
--   ので状態列には使わない。
--
-- 【触らないもの】menus / staff / staff_menus / staff_shifts / bookings の既存列。
--   既存の予約フローの挙動を1ミリも変えないのがこのマイグレーションの条件。


-- ============================================================
-- 1. connector の種別(kind)と capability
--    根拠 = BeautyMerit の一元管理画面(実物)で、媒体ごとに「取得」「更新」で
--    できることが3〜8種と違っていた。「繋がっている」だけでは何ができるか
--    決まらないので、媒体ごとの能力を明示的に持つ。
--
--    read_bookings が無い connector は外部の埋まりを読めない = 空きを判定できない。
--    write_booking が無い connector はHARKの予約を外部に塞げない
--    = その媒体経由の二重予約を防げない。どちらも gate で判定する。
--
--    kind に CHECK を使わない理由は 050 の provider と同じ。additive-only では
--    後から CHECK を変更できず、新しい種別を足せなくなる。
-- ============================================================
ALTER TABLE connector_providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'booking_site';

-- capability も CHECK ではなく「文字列の語彙を固定する」方針。
-- 今使う4つ: read_bookings / write_booking / cancel_booking / read_shifts
-- 将来枠:    write_capacity / write_style / write_coupon / write_staff /
--            write_hours / write_blog
CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider   TEXT NOT NULL REFERENCES connector_providers(id),
  capability TEXT NOT NULL,
  PRIMARY KEY (provider, capability)
);

-- 「読み取り専用連携」の顧客承諾フラグ。
-- write_booking を持たない connector は、HARKの予約を外部に塞げない。それでも
-- 使いたい顧客がいるので、承諾がある場合だけ gate が通す(既定は承諾なし
-- = fail-closed)。判定に必要なので接続ごとに持つ。
ALTER TABLE connectors ADD COLUMN readonly_ack INTEGER NOT NULL DEFAULT 0;


-- ============================================================
-- 2. 設備(resource)
--    ネイル・まつげ・エステへの展開があるので、テーブルとロジックは今入れる。
--    UIとデータは後。美容室では1行も入らず resource_id IS NULL で素通りする。
--
--    今入れる理由 = 空き計算と二重予約防止はHARKで最も壊してはいけない場所で、
--    顧客が自社1店舗だけの今なら壊しても自分の店で済む。他社が動き出してから
--    書き換えると、間違えれば全店で二重予約になる。
-- ============================================================
CREATE TABLE IF NOT EXISTS resources (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  business_unit_id TEXT NOT NULL,
  name             TEXT NOT NULL,                 -- 席1 / ベッドA / 個室 / 機器名
  kind             TEXT NOT NULL DEFAULT 'seat',  -- seat / bed / room / machine
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (business_unit_id, line_account_id) REFERENCES business_units(id, line_account_id)
);
-- 複合外部キーの親側(テナント境界をDBで守るために必要)
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_id_account ON resources (id, line_account_id);
CREATE INDEX IF NOT EXISTS idx_resources_bu ON resources (business_unit_id, is_active);

-- menus 側の複合外部キーの親。(id は PK なので既存行で重複しない)
CREATE UNIQUE INDEX IF NOT EXISTS idx_menus_id_account ON menus (id, line_account_id);

-- このメニューはこの設備を使う(N:M)。
-- 空き計算は「メニュー → 使う設備 → その設備の埋まり」の順に引く。
CREATE TABLE IF NOT EXISTS menu_resources (
  menu_id         TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  line_account_id TEXT NOT NULL,                  -- テナント境界を複合FKで守るために持つ
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (menu_id, resource_id),
  FOREIGN KEY (menu_id,     line_account_id) REFERENCES menus(id, line_account_id),
  FOREIGN KEY (resource_id, line_account_id) REFERENCES resources(id, line_account_id)
);
-- 設備からメニューを引く向き(PK の先頭列が menu_id なので別に要る)
CREATE INDEX IF NOT EXISTS idx_menu_resources_resource ON menu_resources (resource_id);

-- その予約がどの設備を使ったか。美容室では NULL のまま。
ALTER TABLE bookings ADD COLUMN resource_id TEXT REFERENCES resources(id);
CREATE INDEX IF NOT EXISTS idx_bookings_resource ON bookings (resource_id, starts_at);


-- ============================================================
-- 3. 予約の出どころを追えるようにする
--    現状、同期ブロックは「ダミー friend_id + ダミー menu_id」と
--    external_event_id の 'hpbsync:' 接頭辞でしか識別できない。connector が
--    2つになった瞬間にどちらの同期ブロックか区別できず、片方の同期が壊れた時に
--    もう片方のブロックまで消しうる。
--
--    external_event_id は "Phase 3 余地 (Google Calendar)" 用の列なので流用を
--    やめ、意味を分ける。(既存列は additive-only で消せないので残したまま、
--    新しい書き込みを新しい列へ寄せる)
-- ============================================================
ALTER TABLE bookings ADD COLUMN connector_id TEXT REFERENCES connectors(id);
ALTER TABLE bookings ADD COLUMN external_ref TEXT;   -- 外部側の予約ID
CREATE INDEX IF NOT EXISTS idx_bookings_connector ON bookings (connector_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_external_ref ON bookings (connector_id, external_ref);


-- ============================================================
-- 4. 同期の単位(scope)と、その状態
--    粒度 = business_unit x connector x staff x resource
--    判断基準 =「その単位だけ同期に失敗しても、他を安全に営業できるか」
--
--    staff を含める根拠 = HARKの実装は全部スタッフ単位。staff_connectors の PK が
--    (staff_id, connector_id) で、二重予約判定も staff_id の overlap。実物と整合する。
--    resource は美容室では NULL。後から一意キーに足すと作り直し = 再構築になるので
--    最初から入れる。
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_scopes (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL,
  business_unit_id        TEXT NOT NULL,
  connector_id            TEXT NOT NULL,
  staff_id                TEXT,
  resource_id             TEXT,
  -- 状態。既定は blocked = 何も分かっていないうちは売らない(fail-closed)
  readiness               TEXT NOT NULL DEFAULT 'blocked',   -- ready / blocked
  phase                   TEXT NOT NULL DEFAULT 'idle',      -- idle / bootstrap / refresh
  -- 世代。部分的にしか作れていない台帳を公開しないための二重化。
  -- building を作り切ってから published に切り替える。
  published_generation    INTEGER,
  building_generation     INTEGER,
  coverage_through        TEXT,      -- どこまでの日付を同期できたか(販売上限と比較する)
  fresh_until             TEXT,      -- これを過ぎたら販売を閉じる(dead-man switch)
  last_successful_sync_at TEXT,      -- 「実行した」ではなく「成功した」時刻。失敗では進めない
  last_manual_run_at      TEXT,      -- 手動実行。自動と混ぜて表示しない
  sync_started_at         TEXT,      -- phase のままスタックした時の復帰判定に使う
  last_error_at           TEXT,
  last_error_code         TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (business_unit_id, line_account_id) REFERENCES business_units(id, line_account_id),
  FOREIGN KEY (connector_id,     line_account_id) REFERENCES connectors(id, line_account_id),
  FOREIGN KEY (staff_id,         line_account_id) REFERENCES staff(id, line_account_id),
  FOREIGN KEY (resource_id,      line_account_id) REFERENCES resources(id, line_account_id)
);
-- 同じ組み合わせを2行作らない。NULL を含むので COALESCE で正規化する
-- (SQLite の UNIQUE は NULL 同士を別物と見なすため、素の列指定では重複を防げない)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_scopes_uniq
  ON sync_scopes (line_account_id, business_unit_id, connector_id,
                  COALESCE(staff_id, '-'), COALESCE(resource_id, '-'));

-- 実行履歴。状態列は「今」しか持てないので、障害解析のために履歴を別に持つ。
CREATE TABLE IF NOT EXISTS sync_runs (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL REFERENCES sync_scopes(id),
  generation       INTEGER NOT NULL,
  run_type         TEXT NOT NULL,   -- bootstrap / refresh / manual
  status           TEXT NOT NULL,   -- running / succeeded / failed
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  coverage_from    TEXT,
  coverage_through TEXT,
  error_code       TEXT,
  error_message    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_scope ON sync_runs (scope_id, started_at DESC);

-- ホストをまたぐ二重起動防止。
-- 現在の poc2/lib_lock.sh は /tmp の mkdir ロックなので同一ホスト内でしか効かない。
-- VPS移行時に「旧Mac + 新VPS」の二重起動が現実的なリスクになる。
-- fencing_token = リースを取り直すたびに増やす番号。遅れて復帰した旧ホストの
-- 書き込みを、番号が古いことを根拠に捨てられるようにする。
CREATE TABLE IF NOT EXISTS job_leases (
  job_name       TEXT PRIMARY KEY,
  lease_owner    TEXT NOT NULL,
  lease_until    TEXT NOT NULL,
  fencing_token  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);


-- ============================================================
-- 5. 「今この scope で売ってよいか」の判定を1箇所に閉じ込める VIEW
--    アプリは sync_scopes を直接見ない。必ずこの VIEW 経由で見る。
--    条件をアプリ各所に書くと、必ずどこかで書き漏れる。
--
--    名前に v1 を付けてあるのは、後で判定条件を変えたくなった時に、古い定義を
--    使っている箇所を残したまま v2 を並べられるようにするため
--    (additive-only では VIEW も差し替えではなく追加になる)。
-- ============================================================
CREATE VIEW IF NOT EXISTS bookable_scopes_v1 AS
SELECT s.*
  FROM sync_scopes s
  JOIN connectors c ON c.id = s.connector_id
 WHERE c.is_active = 1
   AND c.deleted_at IS NULL
   AND s.readiness = 'ready'
   AND s.fresh_until IS NOT NULL
   AND s.fresh_until > strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours');


-- ============================================================
-- 6. バックフィル
--
--    実在の provider は 050 で入れた3件。種別は実物に合わせて個別に決める。
--      salonboard     … 予約媒体そのもの          -> booking_site
--      rakuten_beauty … 予約媒体そのもの          -> booking_site
--      beautymerit    … 媒体ではなく一元管理のハブ -> salon_manager
--
--    連携先の追加は INSERT 1行で済む。その時に kind と capability を明示的に
--    入れる(既定の 'booking_site' に黙って乗せない)。
-- ============================================================
UPDATE connector_providers SET kind = 'booking_site'  WHERE id IN ('salonboard', 'rakuten_beauty');
UPDATE connector_providers SET kind = 'salon_manager' WHERE id = 'beautymerit';

-- 予約媒体(booking_site)は4つとも持つ
INSERT OR IGNORE INTO provider_capabilities (provider, capability)
  SELECT id, 'read_bookings'  FROM connector_providers WHERE kind = 'booking_site';
INSERT OR IGNORE INTO provider_capabilities (provider, capability)
  SELECT id, 'write_booking'  FROM connector_providers WHERE kind = 'booking_site';
INSERT OR IGNORE INTO provider_capabilities (provider, capability)
  SELECT id, 'cancel_booking' FROM connector_providers WHERE kind = 'booking_site';
INSERT OR IGNORE INTO provider_capabilities (provider, capability)
  SELECT id, 'read_shifts'    FROM connector_providers WHERE kind = 'booking_site';

-- BeautyMerit は一元管理画面の実物に「取得：予約」「更新：予約」がある。
-- 「取得：シフト」に当たる行は無い(BMは書く側)ので read_shifts は入れない。
INSERT OR IGNORE INTO provider_capabilities (provider, capability) VALUES
  ('beautymerit', 'read_bookings'),
  ('beautymerit', 'write_booking'),
  ('beautymerit', 'cancel_booking');

-- 既存 connector を readiness='ready' にはしない。
-- 実測でジョブBが9日14時間止まっており、現在の台帳が外部と一致している保証が無い。
-- 「一致している」という未検証の事実をDBに書くことになるので、書かない。
-- 全 scope は readiness='blocked' から始め、自社の scope も1回 full bootstrap を
-- 通して ready に上げる。他社販売前の今が、それができる最後のタイミング。
--
-- したがって sync_scopes への行の作成もここでは行わない(0件が正常)。
-- scope は接続が実在するときに作る。これは 050 で connectors を作らなかったのと
-- 同じ理由。
