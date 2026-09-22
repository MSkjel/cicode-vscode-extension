// workspace.findFiles globs are case-sensitive, but the compiler treats file names
// case-insensitively (FOO.CI and LABELS.DBF are compiled like foo.ci and labels.DBF).

/** Every Cicode source file. */
export const CI_FILE_GLOB = "**/*.[cC][iI]";

/** Every labels.DBF table. */
export const LABELS_DBF_GLOB = "**/[lL][aA][bB][eE][lL][sS].[dD][bB][fF]";

/** Every locvar.DBF table. */
export const LOCVAR_DBF_GLOB = "**/[lL][oO][cC][vV][aA][rR].[dD][bB][fF]";
