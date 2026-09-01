-- Migration 050: 営業単位(business_units) と 外部接続(connectors) の分離
--
-- 【この形にした理由】
-- 予約には性質の違う2つの軸がある。
--   ① 予約が「どの営業単位(店舗)に属するか」          … 1件の予約に対して必ず1つ
--   ② 予約を「どの外部予約サービスに流すか」          … 1件の予約に対して 0〜N 個
-- 初版ではこの2つを bookings.connector_id 1本で表そうとしていたが、実在の顧客が
-- 既に「1店舗が SALON BOARD と BeautyMerit の2接続を持つ」構成だったため成立しない。
-- additive-only の環境では後から列を消せないので、適用前の今のうちに分離する。
--
-- 【方針】additive-only (CONTRIBUTING.md §Migration Policy / scripts/check-migrations.ts)
--   ✅ CREATE TABLE / ADD COLUMN(NULL or DEFAULT) / CREATE [UNIQUE] INDEX / INSERT
--   ❌ DROP TABLE / DROP COLUMN / ALTER COLUMN TYPE / RENAME / ADD COLUMN NOT NULL(DEFAULT無し) / ADD UNIQUE
--
-- 【触らないもの】menus / staff / staff_menus / staff_shifts。
--   店舗別のメニュー・料金は staff_menus の is_offered / override_price で既に表現できる。
--
-- 【テナント境界】staff_connectors / business_unit_connectors は line_account_id を持ち、
--   親側の UNIQUE INDEX と組んだ複合外部キーで「テナントを跨いだ紐づけ」をDBが拒否する。
--   （CREATE UNIQUE INDEX は additive-only で許可されているので、この形が取れる）

-- ============================================================
-- 1. business_units: 予約が属する営業単位(店舗)
--    外部連携の有無に関わらず必ず1件以上存在する。予約は必ずここに属する。
-- ============================================================
CREATE TABLE IF NOT EXISTS business_units (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  name            TEXT NOT NULL,               -- 「覚王山店」など
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_business_units_account ON business_units (line_account_id, is_active);
-- 複合外部キーの親側。テナント境界をDBで守るために必要
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_units_id_account ON business_units (id, line_account_id);

-- ============================================================
-- 2. connector_providers: 連携先の種別(参照テーブル)
--    ⚠️ provider に CHECK 制約を使わない。additive-only では後から CHECK を変更できず
--       新しい連携先を足せなくなるため(bookings.status の CHECK が同じ轍の実例)。
--    🟢 参照テーブルなら「拡張は INSERT 1行」かつ「表記ゆれ('salonbaord' 等)はFKが拒否」。
-- ============================================================
CREATE TABLE IF NOT EXISTS connector_providers (
  id         TEXT PRIMARY KEY,                 -- 'salonboard' | 'beautymerit' | 'rakuten_beauty'
  label      TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
INSERT OR IGNORE INTO connector_providers (id, label) VALUES
  ('salonboard',     'SALON BOARD'),
  ('beautymerit',    'BeautyMerit'),
  ('rakuten_beauty', '楽天ビューティ');

-- ============================================================
-- 3. connectors: 外部予約サービスへの接続
--    粒度 = 「認証情報1組 = 1 connector」。店舗ではない。
--    根拠 = 実在の申込書が「契約アカウント数4・契約店舗3」でアカウントと店舗が一致しない。
--    🔴 外部接続が実在するときだけ作る。行が0件でも正常。
--    🔴 認証情報(ID/パスワード/APIキー)の列をここに足さないこと。
--       providerごとに認証方式が違い、additive-only では要らなくなった列を永久に消せない。
--       DBに持つと決めた時は connector_credentials 子テーブルを別に作る。
--    🔴 課金用の列も足さないこと。is_active(技術的な接続状態)と課金状態は別概念。
-- ============================================================
CREATE TABLE IF NOT EXISTS connectors (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  provider        TEXT NOT NULL REFERENCES connector_providers(id),
  display_name    TEXT NOT NULL,               -- 接続の呼び名(管理画面用)。店舗名は business_units 側
  is_active       INTEGER NOT NULL DEFAULT 1,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_connectors_account ON connectors (line_account_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_id_account ON connectors (id, line_account_id);

-- ============================================================
-- 4. business_unit_connectors: 店舗 x 接続 (N:M)
--    「1店舗が2つの外部サービスに繋がる」「1接続が複数店舗を持つ」の両方を表現できる。
--    external_shop_ref = その接続における、この店舗の識別子。
--    ⚠️ 店舗の識別子を connectors 側に置かない。1認証で複数店舗を扱うサービスが1つでも
--       出た時点で表現できなくなるため。
-- ============================================================
CREATE TABLE IF NOT EXISTS business_unit_connectors (
  business_unit_id  TEXT NOT NULL,
  connector_id      TEXT NOT NULL,
  line_account_id   TEXT NOT NULL,             -- テナント境界を複合FKで守るために持つ
  external_shop_ref TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (business_unit_id, connector_id),
  FOREIGN KEY (business_unit_id, line_account_id) REFERENCES business_units(id, line_account_id),
  FOREIGN KEY (connector_id, line_account_id) REFERENCES connectors(id, line_account_id)
);
CREATE INDEX IF NOT EXISTS idx_buc_connector ON business_unit_connectors (connector_id, is_active);

-- ============================================================
-- 5. staff_connectors: スタッフ x 接続
--    external_staff_ref = 連携先でのスタイリストID。poc2/staff_map.json の置き換え先。
--    PK が (staff_id, connector_id) なので、複数の接続に出るスタッフは複数行持てる。
--    ⚠️ is_primary は置かない。「どれが主か」は接続側ではなく所属(business_unit)側の話であり、
--       一意性を保証できない旗を作ると ORDER BY ... LIMIT 1 が非決定になる。
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_connectors (
  staff_id           TEXT NOT NULL,
  connector_id       TEXT NOT NULL,
  line_account_id    TEXT NOT NULL,            -- テナント境界を複合FKで守るために持つ
  external_staff_ref TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (staff_id, connector_id),
  FOREIGN KEY (staff_id, line_account_id) REFERENCES staff(id, line_account_id),
  FOREIGN KEY (connector_id, line_account_id) REFERENCES connectors(id, line_account_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_connectors_conn ON staff_connectors (connector_id, is_active);

-- staff 側の複合外部キーの親。(id は PK なので既存行で重複しない)
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_id_account ON staff (id, line_account_id);

-- ============================================================
-- 6. bookings.business_unit_id: 予約がどの営業単位に属するか
--    🔴 REFERENCES を最初から付ける。値の「存在」ではなく「正しさ」を保証するため
--       (FKが無いと 'typo_123' のような実在しないIDが入り、NULL監視をすり抜ける)。
--    NULL 許容なのは additive-only の制約(ADD COLUMN NOT NULL は禁止)。
--    運用上は下のバックフィルと書き込み側の fail-closed により NULL を作らない。
-- ============================================================
ALTER TABLE bookings ADD COLUMN business_unit_id TEXT REFERENCES business_units(id);
CREATE INDEX IF NOT EXISTS idx_bookings_business_unit ON bookings (business_unit_id, starts_at);

-- ============================================================
-- 7. バックフィル
--    id は line_account_id から決定的に導出する('bu_' || id)。環境ごとの書き換えが不要で、
--    デモD1・本番D1・新規インストールで同じSQLが流れ、再実行しても増えない(冪等)。
--    🟢 connectors / business_unit_connectors / staff_connectors は作らない。
--       外部接続は実在するときだけ登録する(0件が正常)。実接続の登録は適用後に手で行う。
-- ============================================================
INSERT INTO business_units (id, line_account_id, name)
  SELECT 'bu_' || la.id, la.id, la.name
    FROM line_accounts la
   WHERE NOT EXISTS (
     SELECT 1 FROM business_units b WHERE b.line_account_id = la.id
   );

UPDATE bookings
   SET business_unit_id = 'bu_' || line_account_id
 WHERE business_unit_id IS NULL
   AND EXISTS (
     SELECT 1 FROM business_units b WHERE b.id = 'bu_' || bookings.line_account_id
   );
