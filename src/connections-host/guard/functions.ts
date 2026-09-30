import type { SqlDialect } from '@shared/domain/project-resources';

/**
 * Functions the guard knows per dialect. `DENIED` functions are refused in read-only mode even though they only
 * read: they sleep, lock, touch files or the network, end other sessions, change session state that outlives the
 * query in a pooled connection, or run SQL given as a string. `BUILTIN` functions are known to be part of the engine;
 * any other function counts as user-defined (the bridge cannot know whether it writes) and is refused in read-only
 * mode unless the resource allows user functions.
 */

const set = (...lists: string[]) =>
  new Set(
    lists
      .join(' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );

// ── denied (reason per entry, tested one by one) ──

export const DENIED: Record<SqlDialect, Record<string, string>> = {
  postgresql: {
    nextval: 'advances a sequence',
    setval: 'changes a sequence',
    set_config: 'changes a session setting',
    setseed: 'changes the session',
    pg_terminate_backend: 'ends another session',
    pg_cancel_backend: 'cancels another session',
    pg_signal_backend: 'signals another session',
    pg_reload_conf: 'reloads the server configuration',
    pg_rotate_logfile: 'rotates the server log',
    pg_switch_wal: 'switches the WAL file',
    pg_promote: 'promotes a standby',
    pg_create_restore_point: 'writes a restore point',
    pg_notify: 'sends a notification',
    pg_sleep: 'waits',
    pg_sleep_for: 'waits',
    pg_sleep_until: 'waits',
    pg_read_file: 'reads a server file',
    pg_read_binary_file: 'reads a server file',
    pg_ls_dir: 'lists a server folder',
    pg_ls_logdir: 'lists a server folder',
    pg_ls_waldir: 'lists a server folder',
    pg_ls_tmpdir: 'lists a server folder',
    pg_ls_archive_statusdir: 'lists a server folder',
    pg_stat_file: 'reads server file metadata',
    pg_file_write: 'writes a server file',
    lo_import: 'reads a server file into the database',
    lo_export: 'writes a server file',
    lo_create: 'creates a large object',
    lo_unlink: 'deletes a large object',
    lo_put: 'writes a large object',
    lo_from_bytea: 'creates a large object',
    dblink: 'connects to another database',
    dblink_exec: 'runs SQL in another database',
    dblink_connect: 'connects to another database',
    dblink_connect_u: 'connects to another database',
    dblink_open: 'connects to another database',
    dblink_send_query: 'runs SQL in another database',
    pg_advisory_lock: 'takes a session lock',
    pg_advisory_lock_shared: 'takes a session lock',
    pg_try_advisory_lock: 'takes a session lock',
    pg_try_advisory_lock_shared: 'takes a session lock',
    pg_advisory_xact_lock: 'takes a lock',
    pg_advisory_xact_lock_shared: 'takes a lock',
    pg_try_advisory_xact_lock: 'takes a lock',
    pg_try_advisory_xact_lock_shared: 'takes a lock',
    query_to_xml: 'runs SQL given as a string',
    query_to_xmlschema: 'runs SQL given as a string',
    query_to_xml_and_xmlschema: 'runs SQL given as a string',
    cursor_to_xml: 'reads a cursor',
    pg_logical_emit_message: 'writes to the WAL',
    pg_create_logical_replication_slot: 'creates a replication slot',
    pg_create_physical_replication_slot: 'creates a replication slot',
    pg_drop_replication_slot: 'drops a replication slot',
    pg_replication_origin_create: 'creates a replication origin',
    pg_stat_reset: 'resets statistics',
    pg_stat_reset_shared: 'resets statistics',
    pg_stat_reset_single_table_counters: 'resets statistics',
    pg_stat_reset_single_function_counters: 'resets statistics',
    pg_stat_statements_reset: 'resets statistics',
    txid_current: 'assigns a transaction id',
    pg_current_xact_id: 'assigns a transaction id',
    pg_import_system_collations: 'changes the catalog',
  },
  mysql: {
    sleep: 'waits',
    benchmark: 'runs an expression many times',
    load_file: 'reads a server file',
    get_lock: 'takes a session lock',
    release_lock: 'releases a session lock',
    release_all_locks: 'releases session locks',
    master_pos_wait: 'waits for replication',
    source_pos_wait: 'waits for replication',
    wait_for_executed_gtid_set: 'waits for replication',
    wait_until_sql_thread_after_gtids: 'waits for replication',
    last_insert_id: 'changes the session',
    sys_exec: 'runs a program on the server',
    sys_eval: 'runs a program on the server',
  },
  mariadb: {
    sleep: 'waits',
    benchmark: 'runs an expression many times',
    load_file: 'reads a server file',
    get_lock: 'takes a session lock',
    release_lock: 'releases a session lock',
    release_all_locks: 'releases session locks',
    master_pos_wait: 'waits for replication',
    master_gtid_wait: 'waits for replication',
    last_insert_id: 'changes the session',
    sys_exec: 'runs a program on the server',
    sys_eval: 'runs a program on the server',
    setval: 'changes a sequence',
    nextval: 'advances a sequence',
  },
  sqlserver: {
    openrowset: 'reads a file or another server',
    openquery: 'queries a linked server',
    opendatasource: 'connects to another server',
    xp_cmdshell: 'runs a program on the server',
    xp_dirtree: 'lists a server folder',
    xp_fileexist: 'reads server file metadata',
  },
  sqlite: {
    load_extension: 'loads a library',
    readfile: 'reads a file',
    writefile: 'writes a file',
    edit: 'starts an editor',
    fts3_tokenizer: 'registers native code',
  },
  clickhouse: {
    sleep: 'waits',
    sleepeachrow: 'waits',
    url: 'reads a URL',
    file: 'reads a server file',
    s3: 'reads a bucket',
    s3cluster: 'reads a bucket',
    gcs: 'reads a bucket',
    azureblobstorage: 'reads a bucket',
    hdfs: 'reads HDFS',
    remote: 'queries another server',
    remotesecure: 'queries another server',
    cluster: 'queries a cluster',
    clusterallreplicas: 'queries a cluster',
    mysql: 'connects to another database',
    postgresql: 'connects to another database',
    mongodb: 'connects to another database',
    redis: 'connects to another database',
    sqlite: 'reads a database file',
    jdbc: 'connects to another database',
    odbc: 'connects to another database',
    executable: 'runs a program on the server',
    input: 'reads the request body',
    dictget: 'may load a dictionary from another source',
  },
  oracle: {
    'dbms_lock.sleep': 'waits',
    'dbms_session.sleep': 'waits',
    'dbms_pipe.receive_message': 'waits',
    'dbms_pipe.send_message': 'sends a message',
    'utl_http.request': 'reads a URL',
    'utl_http.request_pieces': 'reads a URL',
    'utl_inaddr.get_host_address': 'resolves a host',
    'utl_inaddr.get_host_name': 'resolves a host',
    'utl_file.fopen': 'opens a server file',
    'dbms_xmlgen.getxml': 'runs SQL given as a string',
    'dbms_xmlquery.getxml': 'runs SQL given as a string',
    'dbms_sql.execute': 'runs SQL given as a string',
    'dbms_scheduler.create_job': 'creates a job',
    'dbms_job.submit': 'creates a job',
  },
};

/** Packages (Oracle) or schemas whose functions are always refused in read-only mode. */
export const DENIED_QUALIFIERS: Partial<Record<SqlDialect, Record<string, string>>> = {
  oracle: {
    utl_http: 'reaches the network',
    utl_tcp: 'reaches the network',
    utl_smtp: 'sends mail',
    utl_mail: 'sends mail',
    utl_file: 'touches server files',
    utl_inaddr: 'resolves hosts',
    dbms_pipe: 'talks to other sessions',
    dbms_lock: 'locks or waits',
    dbms_scheduler: 'creates jobs',
    dbms_job: 'creates jobs',
    dbms_java: 'runs Java',
    dbms_sql: 'runs dynamic SQL',
    dbms_xmlgen: 'runs dynamic SQL',
    dbms_xmlquery: 'runs dynamic SQL',
  },
};

/** The reason a function is denied, or undefined. */
export function deniedReason(dialect: SqlDialect, name: string, qualifier?: string): string | undefined {
  const list = DENIED[dialect];
  const lower = name.toLowerCase();
  if (qualifier) {
    const q = qualifier.toLowerCase();
    const qualified = list[`${q}.${lower}`];
    if (qualified) return qualified;
    const byQualifier = DENIED_QUALIFIERS[dialect]?.[q];
    if (byQualifier) return byQualifier;
    // pg_catalog.pg_sleep(…) is the same function.
    if (dialect === 'postgresql' && q !== 'pg_catalog') return undefined;
  }
  return list[lower];
}

// ── built-in functions ──

const COMMON_AGGREGATES = 'count sum avg min max';
const COMMON_WINDOW =
  'row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value';

const PG_BUILTIN = set(
  COMMON_AGGREGATES,
  COMMON_WINDOW,
  `array_agg string_agg json_agg jsonb_agg json_agg_strict jsonb_agg_strict json_object_agg jsonb_object_agg
   json_objectagg json_arrayagg bool_and bool_or every bit_and bit_or bit_xor stddev stddev_pop stddev_samp variance
   var_pop var_samp percentile_cont percentile_disc mode corr covar_pop covar_samp regr_avgx regr_avgy regr_count
   regr_intercept regr_r2 regr_slope regr_sxx regr_sxy regr_syy any_value range_agg range_intersect_agg xmlagg`,
  `length char_length character_length octet_length bit_length lower upper initcap trim btrim ltrim rtrim substr
   substring left right lpad rpad repeat replace reverse split_part strpos position concat concat_ws format md5
   sha224 sha256 sha384 sha512 encode decode to_hex to_bin to_oct ascii chr quote_ident quote_literal quote_nullable
   regexp_match regexp_matches regexp_replace regexp_split_to_array regexp_split_to_table regexp_like regexp_count
   regexp_instr regexp_substr starts_with translate overlay string_to_array string_to_table array_to_string unistr
   normalize casefold to_char to_number to_date to_timestamp to_ascii convert convert_from convert_to get_byte
   get_bit set_byte set_bit crc32 crc32c bit_count reverse`,
  `abs ceil ceiling floor round trunc sqrt cbrt power pow exp ln log log10 mod sign pi degrees radians sin cos tan
   cot asin acos atan atan2 sind cosd tand cotd asind acosd atand atan2d sinh cosh tanh asinh acosh atanh random
   random_normal greatest least width_bucket div gcd lcm factorial scale min_scale trim_scale erf erfc`,
  `now current_date current_time current_timestamp localtime localtimestamp age date_part date_trunc date_bin
   date_add date_subtract extract make_date make_time make_timestamp make_timestamptz make_interval justify_days
   justify_hours justify_interval clock_timestamp statement_timestamp transaction_timestamp timeofday isfinite
   timezone overlaps`,
  `json_build_object jsonb_build_object json_build_array jsonb_build_array to_json to_jsonb row_to_json
   array_to_json json_array_length jsonb_array_length json_each jsonb_each json_each_text jsonb_each_text
   json_extract_path jsonb_extract_path json_extract_path_text jsonb_extract_path_text json_object_keys
   jsonb_object_keys json_populate_record jsonb_populate_record json_populate_recordset jsonb_populate_recordset
   json_to_record jsonb_to_record json_to_recordset jsonb_to_recordset json_array_elements jsonb_array_elements
   json_array_elements_text jsonb_array_elements_text json_typeof jsonb_typeof json_strip_nulls jsonb_strip_nulls
   jsonb_set jsonb_set_lax jsonb_insert jsonb_pretty jsonb_path_query jsonb_path_query_array jsonb_path_query_first
   jsonb_path_exists jsonb_path_match jsonb_path_query_tz jsonb_path_exists_tz json_object jsonb_object json_scalar
   json_serialize json_exists json_value json_query json_array json_table`,
  `array_length array_lower array_upper array_ndims array_dims array_append array_prepend array_cat array_position
   array_positions array_remove array_replace array_fill cardinality unnest generate_series generate_subscripts
   array_sample array_shuffle trim_array array_reverse array_sort`,
  `current_database current_catalog current_schema current_schemas current_user current_role session_user user
   version pg_typeof format_type pg_get_viewdef pg_get_indexdef pg_get_constraintdef pg_get_functiondef
   pg_get_function_arguments pg_get_function_result pg_get_triggerdef pg_get_ruledef pg_get_expr
   pg_get_serial_sequence pg_get_userbyid pg_get_keywords pg_get_partkeydef pg_get_statisticsobjdef
   pg_relation_size pg_total_relation_size pg_table_size pg_indexes_size pg_database_size pg_tablespace_size
   pg_size_pretty pg_size_bytes pg_column_size pg_column_compression obj_description col_description
   shobj_description has_table_privilege has_schema_privilege has_database_privilege has_column_privilege
   has_any_column_privilege has_function_privilege has_sequence_privilege has_type_privilege pg_has_role
   pg_table_is_visible pg_type_is_visible pg_function_is_visible pg_backend_pid pg_postmaster_start_time
   pg_conf_load_time pg_is_in_recovery pg_last_wal_receive_lsn pg_last_wal_replay_lsn pg_current_wal_lsn
   inet_client_addr inet_client_port inet_server_addr inet_server_port txid_current_snapshot pg_current_snapshot
   pg_encoding_to_char pg_char_to_encoding to_regclass to_regtype to_regproc to_regprocedure to_regnamespace
   to_regrole to_regoper current_setting pg_relation_filenode pg_relation_filepath pg_blocking_pids
   pg_stat_get_activity pg_indexam_has_property pg_index_has_property pg_index_column_has_property
   pg_options_to_table pg_get_object_address pg_describe_object pg_identify_object num_nonnulls num_nulls
   pg_input_is_valid pg_input_error_info row_security_active pg_collation_is_visible pg_jit_available
   pg_partition_tree pg_partition_ancestors pg_partition_root`,
  `gen_random_uuid uuidv4 uuidv7 uuid_extract_timestamp uuid_extract_version host hostmask network netmask masklen
   family broadcast abbrev set_masklen inet_merge inet_same_family text trunc macaddr8_set7bit to_tsvector
   to_tsquery plainto_tsquery phraseto_tsquery websearch_to_tsquery ts_rank ts_rank_cd ts_headline setweight
   numnode querytree strip tsvector_to_array array_to_tsvector ts_delete ts_filter get_current_ts_config
   lower_inc upper_inc lower_inf upper_inf isempty range_merge multirange xmlparse xmlserialize xmlelement
   xmlforest xmlconcat xmlpi xmlroot xpath xpath_exists xml_is_well_formed`,
  `area center diagonal diameter height width radius npoints pclose popen isclosed isopen box circle line lseg path
   point polygon bound_box`,
  `int2 int4 int8 float4 float8 numeric decimal integer bigint smallint real bool boolean date time timestamp
   timestamptz interval json jsonb uuid bytea char bpchar varchar inet cidr macaddr money oid regclass regtype
   int4range int8range numrange tsrange tstzrange daterange int4multirange int8multirange nummultirange
   tsmultirange tstzmultirange datemultirange`,
);

const MYSQL_BUILTIN = set(
  COMMON_AGGREGATES,
  COMMON_WINDOW,
  `group_concat json_arrayagg json_objectagg bit_and bit_or bit_xor std stddev stddev_pop stddev_samp variance
   var_pop var_samp any_value`,
  `ascii bin bit_length char char_length character_length concat concat_ws elt export_set field find_in_set format
   from_base64 hex insert instr lcase left length like locate lower lpad ltrim make_set mid oct octet_length ord
   position quote regexp_instr regexp_like regexp_replace regexp_substr repeat replace reverse right rpad rtrim
   soundex space strcmp substr substring substring_index to_base64 trim ucase unhex upper weight_string
   match against`,
  `abs acos asin atan atan2 ceil ceiling conv cos cot crc32 degrees div exp floor ln log log10 log2 mod pi pow power
   radians rand round sign sin sqrt tan truncate greatest least`,
  `adddate addtime convert_tz curdate current_date current_time current_timestamp curtime date date_add date_format
   date_sub datediff day dayname dayofmonth dayofweek dayofyear extract from_days from_unixtime get_format hour
   last_day localtime localtimestamp makedate maketime microsecond minute month monthname now period_add
   period_diff quarter sec_to_time second str_to_date subdate subtime sysdate time time_format time_to_sec timediff
   timestamp timestampadd timestampdiff to_days to_seconds unix_timestamp utc_date utc_time utc_timestamp week
   weekday weekofyear year yearweek`,
  `json_array json_array_append json_array_insert json_contains json_contains_path json_depth json_extract
   json_insert json_keys json_length json_merge json_merge_patch json_merge_preserve json_object json_overlaps
   json_pretty json_quote json_remove json_replace json_schema_valid json_schema_validation_report json_search
   json_set json_storage_free json_storage_size json_table json_type json_unquote json_valid json_value
   member json_exists json_detailed json_loose json_compact json_equals json_normalize json_query json_arrayagg`,
  `cast convert coalesce ifnull if nullif isnull interval case charset collation coercibility connection_id
   current_role current_user database found_rows icu_version roles_graphml row_count schema session_user
   system_user user version uuid uuid_short uuid_to_bin bin_to_uuid is_uuid inet_aton inet_ntoa inet6_aton
   inet6_ntoa is_ipv4 is_ipv6 is_ipv4_compat is_ipv4_mapped md5 sha sha1 sha2 compress uncompress
   uncompressed_length random_bytes aes_encrypt aes_decrypt statement_digest statement_digest_text
   format_bytes format_pico_time ps_current_thread_id default values grouping name_const
   st_astext st_geomfromtext st_distance st_distance_sphere st_x st_y point st_contains st_within
   st_intersects st_asgeojson st_geomfromgeojson st_srid st_latitude st_longitude`,
);

const TSQL_BUILTIN = set(
  COMMON_AGGREGATES,
  COMMON_WINDOW,
  `count_big stdev stdevp var varp string_agg checksum_agg grouping grouping_id approx_count_distinct
   approx_percentile_cont approx_percentile_disc percentile_cont percentile_disc`,
  `ascii char charindex concat concat_ws difference format left len lower ltrim nchar patindex quotename replace
   replicate reverse right rtrim soundex space str string_escape string_split stuff substring translate trim
   unicode upper datalength`,
  `abs acos asin atan atn2 ceiling cos cot degrees exp floor log log10 pi power radians rand round sign sin sqrt
   square tan greatest least`,
  `current_timestamp dateadd datediff datediff_big datefromparts datename datepart datetime2fromparts
   datetimefromparts datetimeoffsetfromparts day eomonth getdate getutcdate isdate month smalldatetimefromparts
   switchoffset sysdatetime sysdatetimeoffset sysutcdatetime timefromparts todatetimeoffset year datetrunc
   date_bucket at`,
  `cast convert try_cast try_convert parse try_parse coalesce isnull nullif iif choose isnumeric newid
   newsequentialid`,
  `isjson json_value json_query json_modify openjson json_object json_array json_path_exists`,
  `db_id db_name object_id object_name object_schema_name schema_id schema_name user_id user_name suser_id
   suser_name suser_sname suser_sid current_user session_user system_user host_name host_id app_name
   serverproperty databasepropertyex objectproperty objectpropertyex columnproperty col_length col_name
   type_id type_name typeproperty indexproperty index_col filegroup_name file_name has_perms_by_name
   is_member is_rolemember is_srvrolemember permissions original_login session_context context_info
   scope_identity ident_current ident_seed ident_incr error_message error_number error_line error_severity
   error_state error_procedure formatmessage compress decompress hashbytes checksum binary_checksum
   generate_series stats_date rowcount_big connectionproperty`,
);

const SQLITE_BUILTIN = set(
  COMMON_AGGREGATES,
  COMMON_WINDOW,
  `group_concat string_agg total`,
  `abs changes char coalesce concat concat_ws format glob hex ifnull iif instr last_insert_rowid length like
   likelihood likely lower ltrim max min nullif octet_length printf quote random randomblob replace round rtrim
   sign soundex sqlite_compileoption_get sqlite_compileoption_used sqlite_offset sqlite_source_id sqlite_version
   substr substring total_changes trim typeof unhex unicode unlikely upper zeroblob`,
  `date time datetime julianday unixepoch strftime timediff`,
  `acos acosh asin asinh atan atan2 atanh ceil ceiling cos cosh degrees exp floor ln log log10 log2 mod pi pow
   power radians sin sinh sqrt tan tanh trunc`,
  `json jsonb json_array jsonb_array json_array_length json_error_position json_extract jsonb_extract json_insert
   jsonb_insert json_object jsonb_object json_patch jsonb_patch json_pretty json_remove jsonb_remove json_replace
   jsonb_replace json_set jsonb_set json_type json_valid json_quote json_group_array jsonb_group_array
   json_group_object jsonb_group_object json_each json_tree`,
  `cast`,
);

const ORACLE_BUILTIN = set(
  COMMON_AGGREGATES,
  COMMON_WINDOW,
  `listagg stddev stddev_pop stddev_samp variance var_pop var_samp median percentile_cont percentile_disc
   collect corr covar_pop covar_samp approx_count_distinct any_value json_arrayagg json_objectagg xmlagg`,
  `ascii chr concat initcap instr length lengthb lower lpad ltrim nls_initcap nls_lower nls_upper regexp_count
   regexp_instr regexp_like regexp_replace regexp_substr replace rpad rtrim soundex substr substrb translate trim
   upper to_char to_number to_date to_timestamp to_timestamp_tz to_clob to_nchar to_dsinterval to_yminterval
   numtodsinterval numtoyminterval rawtohex hextoraw asciistr unistr dump vsize`,
  `abs acos asin atan atan2 bitand ceil cos cosh exp floor ln log mod nanvl power remainder round sign sin sinh
   sqrt tan tanh trunc width_bucket greatest least`,
  `add_months current_date current_timestamp dbtimezone extract from_tz last_day localtimestamp months_between
   new_time next_day round sessiontimezone sys_extract_utc sysdate systimestamp tz_offset`,
  `cast coalesce decode nvl nvl2 nullif lnnvl sys_guid uid user userenv sys_context ora_hash standard_hash
   json_value json_query json_object json_array json_table json_exists json_serialize json_transform
   treat xmlelement xmlforest xmltype xmlquery xmlexists xmltable`,
);

const BUILTIN: Partial<Record<SqlDialect, Set<string>>> = {
  postgresql: PG_BUILTIN,
  mysql: MYSQL_BUILTIN,
  mariadb: MYSQL_BUILTIN,
  sqlserver: TSQL_BUILTIN,
  sqlite: SQLITE_BUILTIN,
  oracle: ORACLE_BUILTIN,
};

/** Schemas/qualifiers whose functions are part of the engine. */
const BUILTIN_QUALIFIERS: Partial<Record<SqlDialect, Set<string>>> = {
  postgresql: set('pg_catalog'),
  sqlserver: set('sys'),
  oracle: set('sys standard'),
};

/**
 * True when a function is known to be built into the engine (a user-defined function could write). ClickHouse is
 * not checked: its server enforces read-only queries itself and its user functions are SQL expressions.
 */
export function isBuiltinFunction(dialect: SqlDialect, name: string, qualifier?: string): boolean {
  if (dialect === 'clickhouse') return true;
  const lower = name.toLowerCase();
  if (qualifier) {
    // A built-in schema, or a schema-qualified call of a user function.
    return BUILTIN_QUALIFIERS[dialect]?.has(qualifier.toLowerCase()) === true;
  }
  return BUILTIN[dialect]?.has(lower) === true;
}

/**
 * Keywords that are followed by `(` without being function calls (for the dialects checked with the lexer only:
 * Oracle and ClickHouse).
 */
export const NOT_FUNCTIONS = new Set(
  [
    ...set(
      `select from where and or not in exists as on using values over partition by order group having join inner left
   right full outer cross lateral union all intersect except minus with case when then else end is null like
   between any some into table view window filter within keep distinct limit offset fetch first next rows row
   only returning set default primary key references check unique constraint foreign index array map tuple
   interval settings format final sample prewhere array join global asof semi anti paste`,
    ),
  ].map((w) => w.toUpperCase()),
);
