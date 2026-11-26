-- 001: пользователи и журнал действий (этап 5)

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  username      text NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9._-]{2,64}$'),
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('viewer', 'operator', 'engineer', 'admin')),
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now()
);

-- Журнал: команды (запись в контроллеры) и действия администратора.
-- Значения — jsonb, чтобы хранить число, логическое и строку без потерь
CREATE TABLE journal (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  username  text,
  source    text NOT NULL,
  action    text NOT NULL,
  tag_id    text,
  old_value jsonb,
  new_value jsonb,
  ok        boolean NOT NULL,
  code      text,
  message   text
);

CREATE INDEX journal_ts_idx ON journal (ts DESC);
CREATE INDEX journal_tag_ts_idx ON journal (tag_id, ts DESC) WHERE tag_id IS NOT NULL;
CREATE INDEX journal_user_ts_idx ON journal (username, ts DESC) WHERE username IS NOT NULL;
