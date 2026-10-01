// workspace.findFiles globs are case-sensitive, but the compiler treats file names
// case-insensitively (FOO.CI and LABELS.DBF are compiled like foo.ci and labels.DBF).

/** Every Cicode source file. */
export const CI_FILE_GLOB = "**/*.[cC][iI]";

/** Every labels.DBF table. */
export const LABELS_DBF_GLOB = "**/[lL][aA][bB][eE][lL][sS].[dD][bB][fF]";

/** Every locvar.DBF table. */
export const LOCVAR_DBF_GLOB = "**/[lL][oO][cC][vV][aA][rR].[dD][bB][fF]";

/** Every include.DBF table (the projects a project compiles with). */
export const INCLUDE_DBF_GLOB = "**/[iI][nN][cC][lL][uU][dD][eE].[dD][bB][fF]";

/** MASTER.DBF (the project registry) directly inside a User folder. */
export const MASTER_DBF_PATTERN = "[mM][aA][sS][tT][eE][rR].[dD][bB][fF]";
