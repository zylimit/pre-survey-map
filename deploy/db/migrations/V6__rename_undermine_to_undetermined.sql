-- V6：site_status 枚举拼写纠正 undermine → undetermined（#52 F24 ③）
-- 本意为「未确定」，历史错拼为 undermine。纯数据值更名，无配色/逻辑变更。
-- site_status 是无约束 TEXT 列（无 CHECK 约束），幂等 UPDATE 即可，可安全重跑。
UPDATE site SET site_status = 'undetermined' WHERE site_status = 'undermine';
UPDATE site_snapshot SET site_status = 'undetermined' WHERE site_status = 'undermine';
