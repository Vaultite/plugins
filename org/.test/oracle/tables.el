; -*- lexical-binding: t -*-
;; Runtime data the object parser needs, as JSON (run by gen-tables.ts): entities, and the character classes
;; that decide where words break.
(require 'org)
(require 'org-entities)

(defun tables-ranges (f)
  "Runs of characters with the same non-nil value of F, as [start end value] (end inclusive)."
  (let (out (prev nil) (start 0))
    (dotimes (c #x110000)
      (let ((k (if (and (>= c #xd800) (<= c #xdfff)) nil (funcall f c))))
        (unless (equal k prev)
          (when prev (push (vector start (1- c) prev) out))
          (setq prev k start c))))
    (when prev (push (vector start #x10ffff prev) out))
    (vconcat (nreverse out))))

(with-temp-buffer
  (let ((org-inhibit-startup t)) (org-mode))
  (let ((entities (vconcat (mapcar (lambda (e) (vconcat (mapcar (lambda (x) (cond ((eq x t) t) ((null x) :false) ((stringp x) x) (t (format "%s" x)))) e)))
                                   (seq-filter #'listp (append org-entities-user org-entities)))))
        (syntax (tables-ranges (lambda (c) (string (char-syntax c)))))
        (breakable (tables-ranges (lambda (c) (and (aref (char-category-set c) ?|) "|"))))
        (scripts (tables-ranges (lambda (c) (let ((x (aref char-script-table c))) (and x (symbol-name x))))))
        (categories (tables-ranges (lambda (c) (let ((cs (char-category-set c)))
                                                 (apply #'string (seq-filter (lambda (k) (aref cs k)) '(?^ ?C ?H ?K))))))))
    (let ((j (json-serialize (list :entities entities :syntax syntax :breakable breakable :scripts scripts
                                   :categories (vconcat (seq-filter (lambda (r) (not (equal (aref r 2) ""))) categories))
                                   :combining (vconcat (mapcar (lambda (p) (vector (if (car p) (string (car p)) "") (if (cdr p) (string (cdr p)) ""))) word-combining-categories))
                                   :separating (vconcat (mapcar (lambda (p) (vector (if (car p) (string (car p)) "") (if (cdr p) (string (cdr p)) ""))) word-separating-categories))))))
      (princ (if (multibyte-string-p j) j (decode-coding-string j 'utf-8))))))
