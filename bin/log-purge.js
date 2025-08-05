#!/usr/bin/env node

/**
 * Log-Purge CLI
 * Developed by New Horizon Code - https://newhorizoncode.io
 */

const { program } = require('commander');
const { run } = require('../src/processor');
const packageJson = require('../package.json');
const gradient = require('gradient-string');
const chalk = require('chalk');

// Breathtaking title display with the new custom ASCII art
const showTitle = () => {
  const title = `
@@@        @@@@@@    @@@@@@@@     @@@@@@@   @@@  @@@  @@@@@@@     @@@@@@@@  @@@@@@@@
@@@       @@@@@@@@  @@@@@@@@@     @@@@@@@@  @@@  @@@  @@@@@@@@   @@@@@@@@@  @@@@@@@@
@@!       @@!  @@@  !@@           @@!  @@@  @@!  @@@  @@!  @@@   !@@        @@!
!@!       !@!  @!@  !@!           !@!  @!@  !@!  @!@  !@!  @!@   !@!        !@!
@!!       @!@  !@!  !@! @!@!@     @!@@!@!   @!@  !@!  @!@!!@!    !@! @!@!@  @!!!:!
!!!       !@!  !!!  !!! !!@!!     !!@!!!    !@!  !!!  !!@!@!     !!! !!@!!  !!!!!:
!!:       !!:  !!!  :!!   !!:     !!:       !!:  !!!  !!: :!!    :!!   !!:  !!:
:!:       :!:  !:!  :!:   !::     :!:       :!:  !:!  :!:  !:!   :!:   !::  :!:
 :: ::::  ::::: ::   ::: ::::      ::        ::::: ::  ::   :::    ::: ::::   :: ::::
: :: : :   : :  :     :: :: :       :          : :  :    :   : :    :: :: :   : :: ::
`;
  const customGradient = gradient('blue', 'magenta', 'red');
  console.log(customGradient.multiline(title));
  console.log(customGradient(`                                     v${packageJson.version} by New Horizon Code\n`));
};

async function main() {
  showTitle();

  program
    .version(packageJson.version)
    .argument('<pattern>', 'Glob pattern for files to scan (e.g., "src/**/*.js") or folder path for batch processing')
    .option('-m, --mode <mode>', 'Operation mode: remove, comment, or replace', 'remove')
    .option('-r, --replaceWith <string>', 'Replacement string for "replace" mode (e.g., "logger.info(")')
    .option('-i, --ignore <pattern>', 'Glob pattern for files to ignore')
    .option('--extensions <exts>', 'File extensions to process when using folder paths (e.g., "js,ts,jsx,tsx")', 'js,ts,jsx,tsx,vue')
    .option('--batch-folders', 'Enable batch folder processing with detailed folder statistics', false)
    .option('--dry-run', 'Scan files and show what would be changed without modifying them', false)
    .option('-y, --yes', 'Skip the confirmation prompt before making changes', false)
    .option('--report [filename]', 'Generate a markdown summary report')
    .parse(process.argv);

  const options = program.opts();
  const pattern = program.args[0];

  if (options.mode === 'replace' && !options.replaceWith) {
    console.error(chalk.red('Error: The --replaceWith <string> option is required for "replace" mode.'));
    process.exit(1);
  }

  try {
    await run(pattern, options);
  } catch (error) {
    console.error(`\n${chalk.red.bold('An unexpected error occurred:')}`);
    console.error(error);
    process.exit(1);
  }
}

main();