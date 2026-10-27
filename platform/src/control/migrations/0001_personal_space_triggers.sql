-- A personal space has exactly one possible member: its personal_user_id, as owner (review M7: enforced in the DB).
CREATE TRIGGER `space_member_personal_ins` BEFORE INSERT ON `space_member`
WHEN EXISTS (SELECT 1 FROM `space` s WHERE s.`id` = NEW.`space_id` AND s.`kind` = 'personal'
             AND (s.`personal_user_id` IS NOT NEW.`user_id` OR NEW.`role` <> 'owner'))
BEGIN SELECT RAISE(ABORT, 'personal space: only its owner can be a member'); END;
--> statement-breakpoint
CREATE TRIGGER `space_member_personal_upd` BEFORE UPDATE ON `space_member`
WHEN EXISTS (SELECT 1 FROM `space` s WHERE s.`id` = NEW.`space_id` AND s.`kind` = 'personal'
             AND (s.`personal_user_id` IS NOT NEW.`user_id` OR NEW.`role` <> 'owner'))
BEGIN SELECT RAISE(ABORT, 'personal space: only its owner can be a member'); END;
--> statement-breakpoint
CREATE TRIGGER `space_kind_immutable` BEFORE UPDATE OF `kind`, `personal_user_id` ON `space`
WHEN OLD.`kind` IS NOT NEW.`kind` OR OLD.`personal_user_id` IS NOT NEW.`personal_user_id`
BEGIN SELECT RAISE(ABORT, 'space kind and personal owner are immutable'); END;
