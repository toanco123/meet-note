-- Migration viết tay: extension + đối tượng dùng cho tìm kiếm tiếng Việt.
-- Xem docs/design/03-database.md §0.
-- Drizzle tách câu lệnh theo dấu "statement-breakpoint" và chạy toàn bộ trong MỘT transaction.

CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- unaccent() là STABLE (phụ thuộc search_path) nên KHÔNG dùng được trong index hay
-- generated column. Bọc lại thành IMMUTABLE và chỉ rõ schema của dictionary để kết quả
-- không đổi theo search_path.
CREATE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN public.unaccent('public.unaccent'::regdictionary, $1);
--> statement-breakpoint

-- Postgres không có dictionary tiếng Việt. Dùng parser mặc định + bỏ dấu + 'simple'
-- (chỉ lowercase, không stemming): "Kế hoạch" → 'ke' 'hoach'.
CREATE TEXT SEARCH CONFIGURATION meetnote_vi (COPY = simple);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION meetnote_vi
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
