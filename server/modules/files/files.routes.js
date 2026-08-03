import fs, { promises as fsPromises } from 'fs';
import path from 'path';

import express from 'express';
import mime from 'mime-types';

import { projectsDb } from '@/modules/database/index.js';
import { WORKSPACES_ROOT, validateWorkspacePath } from '@/shared/utils.js';

import {
    expandWorkspacePath,
    getFileTree,
    uploadFilesHandler,
    validateFilename,
    validatePathInProject,
} from './files.service.js';

export function createFilesRouter(authenticateToken) {
    const router = express.Router();

    // Browse filesystem endpoint for project suggestions - uses existing getFileTree
    router.get('/browse-filesystem', authenticateToken, async (req, res) => {
        try {
            const { path: dirPath } = req.query;

            console.log('[API] Browse filesystem request for path:', dirPath);
            console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
            // Default to home directory if no path provided
            const defaultRoot = WORKSPACES_ROOT;
            let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

            // Resolve and normalize the path
            targetPath = path.resolve(targetPath);

            // Security check - ensure path is within allowed workspace root
            const validation = await validateWorkspacePath(targetPath);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.error });
            }
            const resolvedPath = validation.resolvedPath || targetPath;

            // Security check - ensure path is accessible
            try {
                await fs.promises.access(resolvedPath);
                const stats = await fs.promises.stat(resolvedPath);

                if (!stats.isDirectory()) {
                    return res.status(400).json({ error: 'Path is not a directory' });
                }
            } catch (err) {
                return res.status(404).json({ error: 'Directory not accessible' });
            }

            // Use existing getFileTree function with shallow depth (only direct children)
            const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

            // Filter only directories and format for suggestions
            const directories = fileTree
                .filter(item => item.type === 'directory')
                .map(item => ({
                    path: item.path,
                    name: item.name,
                    type: 'directory'
                }))
                .sort((a, b) => {
                    const aHidden = a.name.startsWith('.');
                    const bHidden = b.name.startsWith('.');
                    if (aHidden && !bHidden) return 1;
                    if (!aHidden && bHidden) return -1;
                    return a.name.localeCompare(b.name);
                });

            // Add common directories if browsing home directory
            const suggestions = [];
            let resolvedWorkspaceRoot = defaultRoot;
            try {
                resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
            } catch (error) {
                // Use default root as-is if realpath fails
            }
            if (resolvedPath === resolvedWorkspaceRoot) {
                const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
                const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
                const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

                suggestions.push(...existingCommon, ...otherDirs);
            } else {
                suggestions.push(...directories);
            }

            res.json({
                path: resolvedPath,
                suggestions: suggestions
            });

        } catch (error) {
            console.error('Error browsing filesystem:', error);
            res.status(500).json({ error: 'Failed to browse filesystem' });
        }
    });

    router.post('/create-folder', authenticateToken, async (req, res) => {
        try {
            const { path: folderPath } = req.body;
            if (!folderPath) {
                return res.status(400).json({ error: 'Path is required' });
            }
            const expandedPath = expandWorkspacePath(folderPath);
            const resolvedInput = path.resolve(expandedPath);
            const validation = await validateWorkspacePath(resolvedInput);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.error });
            }
            const targetPath = validation.resolvedPath || resolvedInput;
            const parentDir = path.dirname(targetPath);
            try {
                await fs.promises.access(parentDir);
            } catch (err) {
                return res.status(404).json({ error: 'Parent directory does not exist' });
            }
            try {
                await fs.promises.access(targetPath);
                return res.status(409).json({ error: 'Folder already exists' });
            } catch (err) {
                // Folder doesn't exist, which is what we want
            }
            try {
                await fs.promises.mkdir(targetPath, { recursive: false });
                res.json({ success: true, path: targetPath });
            } catch (mkdirError) {
                if (mkdirError.code === 'EEXIST') {
                    return res.status(409).json({ error: 'Folder already exists' });
                }
                throw mkdirError;
            }
        } catch (error) {
            console.error('Error creating folder:', error);
            res.status(500).json({ error: 'Failed to create folder' });
        }
    });

    // Read file content endpoint
    router.get('/projects/:projectId/file', authenticateToken, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { filePath } = req.query;


            // Security: ensure the requested path is inside the project root
            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            // Resolve the absolute project root via the DB-backed helper; the
            // caller passes the DB-assigned `projectId`, not a folder name.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Handle both absolute and relative paths
            const resolved = path.isAbsolute(filePath)
                ? path.resolve(filePath)
                : path.resolve(projectRoot, filePath);
            const normalizedRoot = path.resolve(projectRoot) + path.sep;
            if (!resolved.startsWith(normalizedRoot)) {
                return res.status(403).json({ error: 'Path must be under project root' });
            }

            const content = await fsPromises.readFile(resolved, 'utf8');
            res.json({ content, path: resolved });
        } catch (error) {
            console.error('Error reading file:', error);
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File not found' });
            } else if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // Serve raw file bytes for previews and downloads.
    router.get('/projects/:projectId/files/content', authenticateToken, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { path: filePath } = req.query;


            // Security: ensure the requested path is inside the project root
            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            // Projects are now addressed by DB `projectId`, resolved to their path here.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Match the text reader endpoint so callers can pass either project-relative
            // or absolute paths without changing how the bytes are served.
            const resolved = path.isAbsolute(filePath)
                ? path.resolve(filePath)
                : path.resolve(projectRoot, filePath);
            const normalizedRoot = path.resolve(projectRoot) + path.sep;
            if (!resolved.startsWith(normalizedRoot)) {
                return res.status(403).json({ error: 'Path must be under project root' });
            }

            // Check if file exists
            try {
                await fsPromises.access(resolved);
            } catch (error) {
                return res.status(404).json({ error: 'File not found' });
            }

            // Get file extension and set appropriate content type
            const mimeType = mime.lookup(resolved) || 'application/octet-stream';
            res.setHeader('Content-Type', mimeType);

            // Stream the file
            const fileStream = fs.createReadStream(resolved);
            fileStream.pipe(res);

            fileStream.on('error', (error) => {
                console.error('Error streaming file:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error reading file' });
                }
            });

        } catch (error) {
            console.error('Error serving binary file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // Save file content endpoint
    router.put('/projects/:projectId/file', authenticateToken, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { filePath, content } = req.body;


            // Security: ensure the requested path is inside the project root
            if (!filePath) {
                return res.status(400).json({ error: 'Invalid file path' });
            }

            if (content === undefined) {
                return res.status(400).json({ error: 'Content is required' });
            }

            // Projects are now addressed by DB `projectId`, resolved to their path here.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Handle both absolute and relative paths
            const resolved = path.isAbsolute(filePath)
                ? path.resolve(filePath)
                : path.resolve(projectRoot, filePath);
            const normalizedRoot = path.resolve(projectRoot) + path.sep;
            if (!resolved.startsWith(normalizedRoot)) {
                return res.status(403).json({ error: 'Path must be under project root' });
            }

            // Write the new content
            await fsPromises.writeFile(resolved, content, 'utf8');

            res.json({
                success: true,
                path: resolved,
                message: 'File saved successfully'
            });
        } catch (error) {
            console.error('Error saving file:', error);
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File or directory not found' });
            } else if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    router.get('/projects/:projectId/files', authenticateToken, async (req, res) => {
        try {

            // Using fsPromises from import

            // Resolve the project's absolute path through the DB (projectId is the
            // primary key of the `projects` table after the identifier migration).
            const actualPath = await projectsDb.getProjectPathById(req.params.projectId);
            if (!actualPath) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Check if path exists
            try {
                await fsPromises.access(actualPath);
            } catch (e) {
                return res.status(404).json({ error: `Project path not found: ${actualPath}` });
            }

            const files = await getFileTree(actualPath, 10, 0, true);
            res.json(files);
        } catch (error) {
            console.error('[ERROR] File tree error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/projects/:projectId/files/create - Create new file or directory
    router.post('/projects/:projectId/files/create', authenticateToken, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { path: parentPath, type, name } = req.body;

            // Validate input
            if (!name || !type) {
                return res.status(400).json({ error: 'Name and type are required' });
            }

            if (!['file', 'directory'].includes(type)) {
                return res.status(400).json({ error: 'Type must be "file" or "directory"' });
            }

            const nameValidation = validateFilename(name);
            if (!nameValidation.valid) {
                return res.status(400).json({ error: nameValidation.error });
            }

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Build and validate target path
            const targetDir = parentPath || '';
            const targetPath = targetDir ? path.join(targetDir, name) : name;
            const validation = validatePathInProject(projectRoot, targetPath);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.error });
            }

            const resolvedPath = validation.resolved;

            // Check if already exists
            try {
                await fsPromises.access(resolvedPath);
                return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
            } catch {
                // Doesn't exist, which is what we want
            }

            // Create file or directory
            if (type === 'directory') {
                await fsPromises.mkdir(resolvedPath, { recursive: false });
            } else {
                // Ensure parent directory exists
                const parentDir = path.dirname(resolvedPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }
                await fsPromises.writeFile(resolvedPath, '', 'utf8');
            }

            res.json({
                success: true,
                path: resolvedPath,
                name,
                type,
                message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
            });
        } catch (error) {
            console.error('Error creating file/directory:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'Parent directory not found' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // PUT /api/projects/:projectId/files/rename - Rename file or directory
    router.put('/projects/:projectId/files/rename', authenticateToken, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { oldPath, newName } = req.body;

            // Validate input
            if (!oldPath || !newName) {
                return res.status(400).json({ error: 'oldPath and newName are required' });
            }

            const nameValidation = validateFilename(newName);
            if (!nameValidation.valid) {
                return res.status(400).json({ error: nameValidation.error });
            }

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Validate old path
            const oldValidation = validatePathInProject(projectRoot, oldPath);
            if (!oldValidation.valid) {
                return res.status(403).json({ error: oldValidation.error });
            }

            const resolvedOldPath = oldValidation.resolved;

            // Check if old path exists
            try {
                await fsPromises.access(resolvedOldPath);
            } catch {
                return res.status(404).json({ error: 'File or directory not found' });
            }

            // Build and validate new path
            const parentDir = path.dirname(resolvedOldPath);
            const resolvedNewPath = path.join(parentDir, newName);
            const newValidation = validatePathInProject(projectRoot, resolvedNewPath);
            if (!newValidation.valid) {
                return res.status(403).json({ error: newValidation.error });
            }

            // Check if new path already exists
            try {
                await fsPromises.access(resolvedNewPath);
                return res.status(409).json({ error: 'A file or directory with this name already exists' });
            } catch {
                // Doesn't exist, which is what we want
            }

            // Rename
            await fsPromises.rename(resolvedOldPath, resolvedNewPath);

            res.json({
                success: true,
                oldPath: resolvedOldPath,
                newPath: resolvedNewPath,
                newName,
                message: 'Renamed successfully'
            });
        } catch (error) {
            console.error('Error renaming file/directory:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File or directory not found' });
            } else if (error.code === 'EXDEV') {
                res.status(400).json({ error: 'Cannot move across different filesystems' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // DELETE /api/projects/:projectId/files - Delete file or directory
    router.delete('/projects/:projectId/files', authenticateToken, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { path: targetPath, type } = req.body;

            // Validate input
            if (!targetPath) {
                return res.status(400).json({ error: 'Path is required' });
            }

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Validate path
            const validation = validatePathInProject(projectRoot, targetPath);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.error });
            }

            const resolvedPath = validation.resolved;

            // Check if path exists and get stats
            let stats;
            try {
                stats = await fsPromises.stat(resolvedPath);
            } catch {
                return res.status(404).json({ error: 'File or directory not found' });
            }

            // Prevent deleting the project root itself
            if (resolvedPath === path.resolve(projectRoot)) {
                return res.status(403).json({ error: 'Cannot delete project root directory' });
            }

            // Delete based on type
            if (stats.isDirectory()) {
                await fsPromises.rm(resolvedPath, { recursive: true, force: true });
            } else {
                await fsPromises.unlink(resolvedPath);
            }

            res.json({
                success: true,
                path: resolvedPath,
                type: stats.isDirectory() ? 'directory' : 'file',
                message: 'Deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting file/directory:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'File or directory not found' });
            } else if (error.code === 'ENOTEMPTY') {
                res.status(400).json({ error: 'Directory is not empty' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });

    router.post('/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

    return router;
}
