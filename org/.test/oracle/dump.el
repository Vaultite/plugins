; -*- lexical-binding: t -*-
;; Emacs's own Org parse of each file as JSON, the reference the parser is checked against (run by oracle.ts).
(require 'org)
(require 'org-element)

(defconst dump-skip '(:parent :buffer :standard-properties :cached :org-element--cache-sync-key :robust-begin
                      :robust-end :mode :granularity :secondary :deferred :fragile-cache :true-level))

(defun dump-node-p (x) (and (consp x) (symbolp (car x)) (memq (car x) (append org-element-all-elements org-element-all-objects '(org-data)))))

(defun dump-pos (p) (if (integerp p) (1- p) p))

(defun dump-value (v)
  (cond ((null v) :null)
        ((eq v t) t)
        ((stringp v) (substring-no-properties v))
        ((numberp v) v)
        ((symbolp v) (symbol-name v))
        ((dump-node-p v) (dump-node v))
        ((and (consp v) (not (listp (cdr v)))) (vector (dump-value (car v)) (dump-value (cdr v))))
        ((consp v) (vconcat (mapcar #'dump-value v)))
        (t (format "%S" v))))

(defun dump-node (node)
  (if (stringp node)
      (substring-no-properties node)
    (let* ((type (org-element-type node)) (out (list (cons 'type (symbol-name type)))) (props (org-element-properties-resolve node)))
      (dolist (k '(:begin :end :contents-begin :contents-end :post-blank :post-affiliated))
        (let ((v (org-element-property k node)))
          (push (cons (intern (substring (symbol-name k) 1)) (if (and (integerp v) (not (eq k :post-blank))) (dump-pos v) (dump-value v))) out)))
      (let ((pl (nth 1 node)))
        (while pl
          (let ((k (car pl)) (v (cadr pl)))
            (unless (or (memq k dump-skip) (memq k '(:begin :end :contents-begin :contents-end :post-blank :post-affiliated)))
              (push (cons (if (eq k :type) 'kind (intern (substring (symbol-name k) 1))) (dump-value v)) out)))
          (setq pl (cddr pl))))
      (let ((kids (org-element-contents node)))
        (when kids (push (cons 'children (vconcat (mapcar #'dump-node kids))) out)))
      (nreverse out))))

(defun dump-file (in out)
  (with-temp-buffer
    (insert-file-contents in)
    (let ((org-inhibit-startup t)) (org-mode))
    (let ((tree (org-element-parse-buffer)))
      (with-temp-file out (set-buffer-file-coding-system 'utf-8) (let ((j (json-serialize (dump-node tree)))) (insert (if (multibyte-string-p j) j (decode-coding-string j 'utf-8))))))))

(let ((args command-line-args-left))
  (while args (dump-file (car args) (cadr args)) (setq args (cddr args))))
