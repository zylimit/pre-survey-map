-- pre-survey-map V1 schema
-- PostgreSQL 16 + PostGIS

CREATE EXTENSION IF NOT EXISTS postgis;

-- Site: 点要素，(site_id, option) 联合主键
-- 已知关键字段显式建列；Excel 50 列扩展统一存入 extras (JSONB)
CREATE TABLE IF NOT EXISTS site (
    site_id      TEXT        NOT NULL,
    "option"     TEXT        NOT NULL DEFAULT '',
    project      TEXT,
    site_status  TEXT,
    lati         DOUBLE PRECISION,
    longi        DOUBLE PRECISION,
    extras       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom         GEOMETRY(Point, 4326),
    PRIMARY KEY (site_id, "option")
);

CREATE INDEX IF NOT EXISTS site_geom_idx ON site USING GIST (geom);
CREATE INDEX IF NOT EXISTS site_status_idx ON site (site_status);

-- Road: 线要素，自增主键
CREATE TABLE IF NOT EXISTS road (
    id           BIGSERIAL   PRIMARY KEY,
    property     TEXT,
    extras       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom         GEOMETRY(LineString, 4326)
);

CREATE INDEX IF NOT EXISTS road_geom_idx ON road USING GIST (geom);

-- Lessor: 面要素，fid 主键
CREATE TABLE IF NOT EXISTS lessor (
    fid              TEXT        PRIMARY KEY,
    lessor_name      TEXT,
    lessor_category  TEXT,
    relationship     TEXT,
    extras           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom             GEOMETRY(Polygon, 4326)
);

CREATE INDEX IF NOT EXISTS lessor_geom_idx ON lessor USING GIST (geom);
CREATE INDEX IF NOT EXISTS lessor_relationship_idx ON lessor (relationship);
