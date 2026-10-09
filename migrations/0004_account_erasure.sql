-- phase: expand
-- ADR-033 account deletion (server/domain/account-data.js): context revisions and market observations stay
-- append-only, with one exception. Inside the account-erasure transaction, and only there (it sets
-- trade.account_erasure = 'on' with set_config(..., true), so the setting ends with the transaction), the person's
-- id may leave a row: a revision's author becomes NULL and their id leaves meta.authorship.authors (also on a
-- revision someone else wrote with them), and an
-- observation's recorded_by becomes 'deleted'. Every other column must stay as it was, so the text, the values and
-- their provenance never change. Deletes keep their old rules.

CREATE OR REPLACE FUNCTION trade_context_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF current_setting('trade.account_erasure', true) = 'on'
            AND (NEW.author IS NULL OR NEW.author IS NOT DISTINCT FROM OLD.author)
            AND (NEW.id, NEW.entity_id, NEW.number, NEW.parent_id, NEW.parent_number, NEW.kind, NEW.reverted_to, NEW.content,
                 NEW.fields, NEW.content_hash, NEW.message, NEW.created_at)
                IS NOT DISTINCT FROM
                (OLD.id, OLD.entity_id, OLD.number, OLD.parent_id, OLD.parent_number, OLD.kind, OLD.reverted_to, OLD.content,
                 OLD.fields, OLD.content_hash, OLD.message, OLD.created_at)
            AND (NEW.meta - 'authorship') IS NOT DISTINCT FROM (OLD.meta - 'authorship')
            AND ((NEW.meta->'authorship') - 'authors') IS NOT DISTINCT FROM ((OLD.meta->'authorship') - 'authors') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'trade_context_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trade_context_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'trade_context_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION trade_obs_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('trade.account_erasure', true) = 'on' AND NEW.recorded_by = 'deleted'
        AND (NEW.id, NEW.instrument_id, NEW.metric, NEW.value, NEW.value_num, NEW.unit, NEW.currency, NEW.period, NEW.observed_at,
             NEW.source_key, NEW.source_item_id, NEW.source_url, NEW.source_ref, NEW.retrieved_at, NEW.max_age_sec, NEW.recorded_at)
            IS NOT DISTINCT FROM
            (OLD.id, OLD.instrument_id, OLD.metric, OLD.value, OLD.value_num, OLD.unit, OLD.currency, OLD.period, OLD.observed_at,
             OLD.source_key, OLD.source_item_id, OLD.source_url, OLD.source_ref, OLD.retrieved_at, OLD.max_age_sec, OLD.recorded_at) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'trade_market_observations rows are immutable';
END
$$;
