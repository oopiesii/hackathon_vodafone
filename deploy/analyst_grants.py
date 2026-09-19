"""Єдина специфікація мінімальних прав analyst для bootstrap та ізольованих тестів."""
from psycopg import sql


def grant_analyst(conn, role='ufv_analyst'):
    role_name=sql.Identifier(role)
    for statement in (
        'grant usage on schema core to {}',
        'grant select on core.analyst_items,core.analyst_rollups,core.analyst_rollup_state,core.refresh_requests,core.analyst_receipts,core.analysis_runs,core.analyst_budget,core.analyst_state,core.ai_summaries,core.current_ai_summaries,core.analyst_summary_schedule to {}',
        'grant select(run_id,raw_item_id,raw_version) on core.analysis_labels to {}',
        'grant insert,update on core.analyst_receipts,core.analysis_runs,core.analysis_labels,core.analyst_budget,core.analyst_state,core.ai_summaries,core.analyst_summary_schedule to {}',
        'grant usage,select on sequence core.ai_summaries_id_seq to {}',
    ):
        conn.execute(sql.SQL(statement).format(role_name))
