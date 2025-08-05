const fs = require('fs/promises');
const path = require('path');
const { glob } = require('glob');
const ora = require('ora');
const chalk = require('chalk');
const gradient = require('gradient-string');
const cliProgress = require('cli-progress');
const boxen = require('boxen');
const readline = require('readline');

// A more robust regex to find console statements, including multiline ones.
const CONSOLE_REGEX = /(?:console|window\.console)\.(log|info|warn|error|debug|assert|dir|table)\((?:[^;]*)\);?/gm;

/**
 * Prompts the user for confirmation.
 */
function askForConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Processes a single file based on the provided options.
 */
async function processFile(filePath, options) {
  try {
    const originalContent = await fs.readFile(filePath, 'utf8');
    let newContent = originalContent;
    let changesMade = 0;
    const detectedLogs = [];
    const fileStats = {
      originalSize: originalContent.length,
      originalLines: originalContent.split('\n').length
    };

    if (options.mode === 'remove') {
      newContent = originalContent.replace(CONSOLE_REGEX, (match, logType, offset) => {
        changesMade++;
        const lineNumber = originalContent.substring(0, offset).split('\n').length;
        detectedLogs.push({
          type: logType,
          line: lineNumber,
          content: match.trim(),
          action: 'removed'
        });
        return '';
      }).replace(/^\s*[\r\n]/gm, ''); // Clean up empty lines
    } else if (options.mode === 'comment') {
      newContent = originalContent.replace(CONSOLE_REGEX, (match, logType, offset) => {
        changesMade++;
        const lineNumber = originalContent.substring(0, offset).split('\n').length;
        detectedLogs.push({
          type: logType,
          line: lineNumber,
          content: match.trim(),
          action: 'commented'
        });
        return `// ${match}`;
      });
    } else if (options.mode === 'replace') {
      newContent = originalContent.replace(/console\.(log|info|warn|error|debug)\s*\(/g, (match, logType, offset) => {
        changesMade++;
        const lineNumber = originalContent.substring(0, offset).split('\n').length;
        detectedLogs.push({
          type: logType,
          line: lineNumber,
          content: match.trim(),
          action: 'replaced',
          replacedWith: options.replaceWith
        });
        return options.replaceWith;
      });
    }

    fileStats.newSize = newContent.length;
    fileStats.newLines = newContent.split('\n').length;
    fileStats.sizeReduction = fileStats.originalSize - fileStats.newSize;
    fileStats.linesReduced = fileStats.originalLines - fileStats.newLines;

    if (changesMade > 0) {
      if (!options.dryRun) {
        await fs.writeFile(filePath, newContent, 'utf8');
      }
      return { 
        filePath, 
        status: 'modified', 
        changes: changesMade,
        detectedLogs,
        fileStats
      };
    }
    return { 
      filePath, 
      status: 'clean', 
      changes: 0,
      detectedLogs: [],
      fileStats
    };
  } catch (error) {
    return { 
      filePath, 
      status: 'error', 
      error: error.message,
      changes: 0,
      detectedLogs: [],
      fileStats: null
    };
  }
}

/**
 * Checks if a path is a directory and converts it to a glob pattern
 */
async function processPatternInput(inputPattern, options) {
  try {
    const stats = await fs.stat(inputPattern);
    if (stats.isDirectory()) {
      const extensions = options.extensions.split(',').map(ext => ext.trim());
      // Normalize path separators for glob - always use forward slashes
      const normalizedPath = inputPattern.replace(/\\/g, '/');
      // Ensure path doesn't end with slash for consistent glob pattern
      const cleanPath = normalizedPath.endsWith('/') ? normalizedPath.slice(0, -1) : normalizedPath;
      const globPattern = `${cleanPath}/**/*.{${extensions.join(',')}}`;
      return { pattern: globPattern, isFolder: true, folderPath: inputPattern };
    }
  } catch (error) {
    // Not a directory, treat as glob pattern
  }
  return { pattern: inputPattern, isFolder: false, folderPath: null };
}

/**
 * Groups files by their parent directories for batch processing statistics
 */
function groupFilesByFolder(files) {
  const folderGroups = {};
  files.forEach(file => {
    const folder = path.dirname(file);
    if (!folderGroups[folder]) {
      folderGroups[folder] = [];
    }
    folderGroups[folder].push(file);
  });
  return folderGroups;
}

/**
 * Main execution function.
 */
async function run(pattern, options) {
  const startTime = Date.now();
  const spinner = ora(chalk.cyan('Discovering files...')).start();
  
  // Process input pattern (could be folder path or glob)
  const { pattern: processedPattern, isFolder, folderPath } = await processPatternInput(pattern, options);
  
  if (isFolder) {
    spinner.text = chalk.cyan(`Scanning folder: ${folderPath} for ${options.extensions} files...`);
  }
  
  const files = await glob(processedPattern, { ignore: options.ignore, nodir: true });
  
  if (files.length === 0) {
    spinner.warn(chalk.yellow(`No files found matching pattern: ${processedPattern}`));
    return;
  }
  
  // Enhanced folder statistics
  let folderInfo = '';
  if (options.batchFolders || isFolder) {
    const folderGroups = groupFilesByFolder(files);
    const folderCount = Object.keys(folderGroups).length;
    folderInfo = ` across ${folderCount} folders`;
  }
  
  spinner.succeed(chalk.green(`Found ${files.length} files${folderInfo} to analyze.`));

  if (!options.dryRun && !options.yes) {
    const proceed = await askForConfirmation(
      chalk.yellow.bold(`\nAbout to modify files in place. This can't be undone. Proceed? (y/N) `)
    );
    if (!proceed) {
      console.log(chalk.red('Operation cancelled by user.'));
      return;
    }
  }

  const progressBar = new cliProgress.SingleBar({
    format: `${gradient.pastel('{bar}')} | {percentage}% | {value}/{total} Files | ${chalk.yellow('File:')} {filename}`,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });
  
  console.log(`\n${chalk.bold.blue('🔥 Purging console logs... Mode: ' + chalk.bold.magenta(options.mode.toUpperCase()))}`);
  progressBar.start(files.length, 0, { filename: 'N/A' });

  const results = [];
  // Process files in parallel for performance
  const promises = files.map(file => 
    processFile(file, options).then(result => {
      results.push(result);
      progressBar.increment({ filename: path.basename(file) });
    })
  );
  await Promise.all(promises);
  
  progressBar.stop();
  console.log(gradient.atlas('\n\n ✨ All Done! ✨\n'));

  const endTime = Date.now();
  const executionTime = endTime - startTime;

  // --- Summary Report ---
  const modifiedFiles = results.filter(r => r.status === 'modified');
  const errorFiles = results.filter(r => r.status === 'error');
  const cleanFiles = results.filter(r => r.status === 'clean');
  const totalChanges = modifiedFiles.reduce((sum, f) => sum + f.changes, 0);

  let summary = [];
  summary.push(chalk.whiteBright.bold('Operation Summary'));
  summary.push('-------------------');
  if (options.dryRun) {
    summary.push(chalk.yellow.bold('⚡ DRY RUN MODE ⚡ - No files were changed.'));
  }
  summary.push(`${chalk.cyan('Total Files Scanned:')} ${chalk.bold(files.length)}`);
  summary.push(`${chalk.green('Files Modified:')}      ${chalk.bold(modifiedFiles.length)}`);
  summary.push(`${chalk.magenta('Total Logs Purged:')}   ${chalk.bold(totalChanges)}`);
  if (errorFiles.length > 0) {
    summary.push(`${chalk.red('Files with Errors:')}   ${chalk.bold(errorFiles.length)}`);
  }

  // Enhanced batch folder statistics
  if (options.batchFolders || isFolder) {
    const folderGroups = groupFilesByFolder(files);
    const folderStats = Object.entries(folderGroups).map(([folder, folderFiles]) => {
      const folderResults = results.filter(r => folderFiles.includes(r.filePath));
      const folderModified = folderResults.filter(r => r.status === 'modified');
      const folderChanges = folderModified.reduce((sum, f) => sum + f.changes, 0);
      return { folder, total: folderFiles.length, modified: folderModified.length, changes: folderChanges };
    });
    
    console.log(chalk.blue.bold('\n📁 Folder Statistics:'));
    folderStats.forEach(stat => {
      if (stat.modified > 0) {
        console.log(`  ${chalk.cyan(stat.folder)}: ${stat.modified}/${stat.total} files modified (${stat.changes} changes)`);
      } else {
        console.log(`  ${chalk.gray(stat.folder)}: ${stat.total} files scanned (clean)`);
      }
    });
  }

  console.log(boxen(summary.join('\n'), {
    padding: 1,
    margin: 1,
    borderStyle: 'round',
    borderColor: 'cyan',
    title: 'Log-Purge Report',
    titleAlignment: 'center',
  }));
  
  if (modifiedFiles.length > 0 && modifiedFiles.length < 15) {
      console.log(chalk.green.bold('Modified Files:'));
      modifiedFiles.forEach(f => console.log(`  - ${f.filePath} (${f.changes} changes)`));
  }
  
  if(options.report){
      await generateMarkdownReport(options.report, {
        files, 
        results,
        modifiedFiles, 
        cleanFiles,
        errorFiles,
        totalChanges,
        executionTime,
        options,
        pattern: processedPattern,
        isFolder,
        folderPath
      });
  }
}

/**
 * Generates a comprehensive markdown report of the operation.
 */
async function generateMarkdownReport(filename, {
  files, 
  results,
  modifiedFiles, 
  cleanFiles,
  errorFiles,
  totalChanges,
  executionTime,
  options,
  pattern,
  isFolder,
  folderPath
}) {
  const reportName = typeof filename === 'string' ? filename : 'log-purge-report.md';
  const spinner = ora(chalk.cyan(`Generating detailed markdown report to ${reportName}...`)).start();
  
  // Calculate detailed statistics
  const logTypeStats = {};
  const totalSizeReduction = modifiedFiles.reduce((sum, f) => sum + (f.fileStats?.sizeReduction || 0), 0);
  const totalLinesReduced = modifiedFiles.reduce((sum, f) => sum + (f.fileStats?.linesReduced || 0), 0);
  
  // Gather log type statistics
  modifiedFiles.forEach(file => {
    file.detectedLogs?.forEach(log => {
      if (!logTypeStats[log.type]) {
        logTypeStats[log.type] = { count: 0, action: log.action };
      }
      logTypeStats[log.type].count++;
    });
  });

  let reportContent = `# 🔥 Log-Purge Execution Report\n\n`;
  
  // Executive Summary
  reportContent += `## 📊 Executive Summary\n\n`;
  reportContent += `| Metric | Value |\n`;
  reportContent += `|--------|-------|\n`;
  reportContent += `| **Execution Date** | ${new Date().toLocaleString()} |\n`;
  reportContent += `| **Execution Time** | ${executionTime}ms (${(executionTime/1000).toFixed(2)}s) |\n`;
  reportContent += `| **Operation Mode** | ${options.mode.toUpperCase()} |\n`;
  reportContent += `| **${isFolder ? 'Folder Path' : 'Glob Pattern'}** | \`${isFolder ? folderPath : pattern}\` |\n`;
  if (isFolder) {
    reportContent += `| **File Extensions** | \`${options.extensions}\` |\n`;
  }
  reportContent += `| **Dry Run Mode** | ${options.dryRun ? '✅ Yes' : '❌ No'} |\n`;
  reportContent += `| **Files Scanned** | ${files.length} |\n`;
  reportContent += `| **Files Modified** | ${modifiedFiles.length} |\n`;
  reportContent += `| **Files Clean** | ${cleanFiles.length} |\n`;
  reportContent += `| **Files with Errors** | ${errorFiles.length} |\n`;
  reportContent += `| **Console Statements ${options.mode === 'remove' ? 'Removed' : options.mode === 'comment' ? 'Commented' : 'Replaced'}** | ${totalChanges} |\n`;
  if (options.mode === 'remove') {
    reportContent += `| **Total Size Reduction** | ${totalSizeReduction} bytes (${(totalSizeReduction/1024).toFixed(2)} KB) |\n`;
    reportContent += `| **Total Lines Reduced** | ${totalLinesReduced} |\n`;
  }
  reportContent += `\n`;

  // Folder Statistics (if batch processing was used)
  if (options.batchFolders || isFolder) {
    const folderGroups = groupFilesByFolder(files);
    const folderStats = Object.entries(folderGroups).map(([folder, folderFiles]) => {
      const folderResults = results.filter(r => folderFiles.includes(r.filePath));
      const folderModified = folderResults.filter(r => r.status === 'modified');
      const folderChanges = folderModified.reduce((sum, f) => sum + f.changes, 0);
      return { folder, total: folderFiles.length, modified: folderModified.length, changes: folderChanges };
    });

    reportContent += `## 📁 Folder Statistics\n\n`;
    reportContent += `| Folder | Files Scanned | Files Modified | Console Statements ${options.mode === 'remove' ? 'Removed' : options.mode === 'comment' ? 'Commented' : 'Replaced'} |\n`;
    reportContent += `|--------|---------------|----------------|----------|\n`;
    folderStats
      .sort((a, b) => b.changes - a.changes)
      .forEach(stat => {
        const relativePath = stat.folder.replace(process.cwd(), '.');
        reportContent += `| \`${relativePath}\` | ${stat.total} | ${stat.modified} | ${stat.changes} |\n`;
      });
    reportContent += `\n`;
  }

  // Console Log Type Breakdown
  if (Object.keys(logTypeStats).length > 0) {
    reportContent += `## 🎯 Console Log Type Breakdown\n\n`;
    reportContent += `| Log Type | Count | Action |\n`;
    reportContent += `|----------|-------|--------|\n`;
    Object.entries(logTypeStats)
      .sort(([,a], [,b]) => b.count - a.count)
      .forEach(([type, stats]) => {
        reportContent += `| \`console.${type}()\` | ${stats.count} | ${stats.action} |\n`;
      });
    reportContent += `\n`;
  }

  // File-by-File Analysis
  if (modifiedFiles.length > 0) {
    reportContent += `## 📝 Modified Files Details\n\n`;
    modifiedFiles.forEach((file, index) => {
      const fileName = path.basename(file.filePath);
      const relativePath = file.filePath.replace(process.cwd(), '.');
      
      reportContent += `### ${index + 1}. \`${fileName}\`\n\n`;
      reportContent += `**Path:** \`${relativePath}\`\n\n`;
      reportContent += `**Summary:**\n`;
      reportContent += `- **Console statements ${options.mode}d:** ${file.changes}\n`;
      
      if (file.fileStats) {
        reportContent += `- **Original size:** ${file.fileStats.originalSize} bytes (${file.fileStats.originalLines} lines)\n`;
        reportContent += `- **New size:** ${file.fileStats.newSize} bytes (${file.fileStats.newLines} lines)\n`;
        if (file.fileStats.sizeReduction > 0) {
          reportContent += `- **Size reduction:** ${file.fileStats.sizeReduction} bytes (${file.fileStats.linesReduced} lines)\n`;
        }
      }
      reportContent += `\n`;

      if (file.detectedLogs && file.detectedLogs.length > 0) {
        reportContent += `**Console statements found:**\n\n`;
        reportContent += `| Line | Type | Action | Content |\n`;
        reportContent += `|------|------|--------|----------|\n`;
        file.detectedLogs.forEach(log => {
          const content = log.content.length > 50 ? log.content.substring(0, 47) + '...' : log.content;
          reportContent += `| ${log.line} | \`${log.type}\` | ${log.action} | \`${content}\` |\n`;
        });
        reportContent += `\n`;
      }
    });
  }

  // Clean Files Summary
  if (cleanFiles.length > 0 && cleanFiles.length <= 20) {
    reportContent += `## ✅ Clean Files (No Console Statements)\n\n`;
    cleanFiles.forEach(file => {
      reportContent += `- \`${path.basename(file.filePath)}\`\n`;
    });
    reportContent += `\n`;
  } else if (cleanFiles.length > 20) {
    reportContent += `## ✅ Clean Files\n\n`;
    reportContent += `${cleanFiles.length} files were scanned and found to be clean (no console statements detected).\n\n`;
  }

  // Error Files
  if (errorFiles.length > 0) {
    reportContent += `## ❌ Files with Errors\n\n`;
    errorFiles.forEach(file => {
      reportContent += `### \`${path.basename(file.filePath)}\`\n`;
      reportContent += `**Path:** \`${file.filePath}\`\n`;
      reportContent += `**Error:** ${file.error}\n\n`;
    });
  }

  // Configuration Details
  reportContent += `## ⚙️ Configuration\n\n`;
  reportContent += `**Command Line Options:**\n`;
  reportContent += `- **Mode:** ${options.mode}\n`;
  if (options.replaceWith) {
    reportContent += `- **Replace With:** \`${options.replaceWith}\`\n`;
  }
  if (options.ignore) {
    reportContent += `- **Ignore Pattern:** \`${options.ignore}\`\n`;
  }
  reportContent += `- **Dry Run:** ${options.dryRun}\n`;
  reportContent += `- **Auto-confirm:** ${options.yes}\n`;
  reportContent += `\n`;

  // Performance Metrics
  reportContent += `## 📈 Performance Metrics\n\n`;
  reportContent += `- **Total execution time:** ${executionTime}ms\n`;
  reportContent += `- **Average time per file:** ${(executionTime / files.length).toFixed(2)}ms\n`;
  reportContent += `- **Files processed per second:** ${(files.length / (executionTime / 1000)).toFixed(2)}\n`;
  reportContent += `- **Console statements processed per second:** ${(totalChanges / (executionTime / 1000)).toFixed(2)}\n`;
  reportContent += `\n`;

  // Footer
  reportContent += `---\n`;
  reportContent += `*Report generated by [Log-Purge](https://github.com/new-horizon-code/log-purge) v${require('../package.json').version}*\n`;
  reportContent += `*Execution completed at ${new Date().toISOString()}*\n`;
  
  await fs.writeFile(reportName, reportContent, 'utf-8');
  spinner.succeed(chalk.green(`Detailed report saved successfully to ${reportName}.`));
}

module.exports = { run };